/**
 * Browser-based drawing optimizer for transparent drawings
 * This file can be loaded in a browser environment to optimize drawings
 */

// Function to get drawings from the server
async function fetchDrawings() {
  try {
    const response = await fetch('http://localhost:3000/api/drawings');
    if (response.ok) {
      return await response.json();
    }
    throw new Error(`Failed to fetch drawings: ${response.statusText}`);
  } catch (error) {
    console.error('Error fetching drawings:', error);
    return [];
  }
}

// Function to optimize a single drawing
async function optimizeDrawing(drawing) {
  return new Promise((resolve, reject) => {
    if (!drawing || !drawing.dataURL) {
      return resolve(drawing);
    }

    // Skip if it's already optimized or very small
    if (drawing.optimized || drawing.dataURL.length < 50000) {
      return resolve(drawing);
    }
    
    try {
      const img = new Image();
      
      img.onload = function() {
        // Target size (capped at 512px max dimension)
        const maxDimension = 512;
        let width = img.width;
        let height = img.height;
        
        // Resize if necessary
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.floor(height * (maxDimension / width));
            width = maxDimension;
          } else {
            width = Math.floor(width * (maxDimension / height));
            height = maxDimension;
          }
        }
        
        // Create canvas for the optimized image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // Clear with transparent background
        ctx.clearRect(0, 0, width, height);
        
        // Draw the image
        ctx.drawImage(img, 0, 0, width, height);
        
        // Get optimized data URL (always use PNG for transparency)
        const optimizedDataURL = canvas.toDataURL('image/png', 0.8);
        
        // Create result object with optimization stats
        const result = {
          ...drawing,
          dataURL: optimizedDataURL,
          optimized: true,
          originalSize: drawing.dataURL.length,
          optimizedSize: optimizedDataURL.length,
          reductionPercent: Math.round((1 - optimizedDataURL.length / drawing.dataURL.length) * 100)
        };
        
        resolve(result);
      };
      
      img.onerror = function() {
        console.error('Failed to load image for optimization');
        resolve(drawing); // Return original if optimization fails
      };
      
      // Start loading the image
      img.src = drawing.dataURL;
      
    } catch (error) {
      console.error('Error optimizing drawing:', error);
      resolve(drawing);
    }
  });
}

// Function to save an optimized drawing back to the server
async function saveOptimizedDrawing(drawing) {
  try {
    const response = await fetch(`http://localhost:3000/api/drawings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(drawing)
    });
    
    if (response.ok) {
      return true;
    }
    
    console.error('Failed to save optimized drawing:', await response.text());
    return false;
  } catch (error) {
    console.error('Error saving optimized drawing:', error);
    return false;
  }
}

// Main function to run the optimizer
async function optimizeAllDrawings() {
  // Create UI for output
  const resultsDiv = document.createElement('div');
  resultsDiv.style.margin = '20px';
  resultsDiv.style.fontFamily = 'monospace';
  document.body.appendChild(resultsDiv);
  
  function log(message) {
    console.log(message);
    const line = document.createElement('div');
    line.textContent = message;
    resultsDiv.appendChild(line);
  }
  
  log('Fetching drawings from server...');
  
  // Get all drawings
  const drawings = await fetchDrawings();
  
  if (!drawings.length) {
    log('No drawings found.');
    return;
  }
  
  log(`Found ${drawings.length} drawings. Starting optimization...`);
  
  // Stats
  let optimizedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let totalSavings = 0;
  
  // Process each drawing
  for (let i = 0; i < drawings.length; i++) {
    const drawing = drawings[i];
    log(`Processing drawing ${i+1}/${drawings.length}: ${drawing.wallKey}`);
    
    try {
      // Skip compressed preview drawings
      if (drawing.isCompressed) {
        log(`Skipping compressed preview drawing: ${drawing.wallKey}`);
        skippedCount++;
        continue;
      }
      
      // Skip already optimized drawings
      if (drawing.optimized) {
        log(`Skipping already optimized drawing: ${drawing.wallKey}`);
        skippedCount++;
        continue;
      }
      
      // Optimize the drawing
      const optimized = await optimizeDrawing(drawing);
      
      // If nothing changed or very small savings, skip saving
      if (!optimized.optimized || optimized.reductionPercent < 5) {
        log(`Drawing ${drawing.wallKey} already optimal (${drawing.dataURL.length} bytes)`);
        skippedCount++;
        continue;
      }
      
      // Save the optimized drawing
      log(`Optimized: ${optimized.originalSize} → ${optimized.optimizedSize} bytes (${optimized.reductionPercent}% reduction)`);
      
      const saved = await saveOptimizedDrawing(optimized);
      if (saved) {
        optimizedCount++;
        totalSavings += (optimized.originalSize - optimized.optimizedSize);
      } else {
        failedCount++;
      }
      
    } catch (error) {
      log(`Error processing drawing ${drawing.wallKey}: ${error.message}`);
      failedCount++;
    }
  }
  
  // Show summary
  log('\nOptimization complete:');
  log(`- Optimized: ${optimizedCount} drawings`);
  log(`- Skipped: ${skippedCount} drawings`);
  log(`- Failed: ${failedCount} drawings`);
  log(`- Total space saved: ${Math.round(totalSavings / 1024)} KB`);
}

// Execute if this is loaded in a browser
if (typeof window !== 'undefined') {
  const button = document.createElement('button');
  button.textContent = 'Start Optimization';
  button.style.padding = '10px';
  button.style.margin = '20px';
  button.style.fontSize = '16px';
  
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Optimizing...';
    optimizeAllDrawings().then(() => {
      button.textContent = 'Optimization Complete';
    });
  });
  
  document.body.appendChild(button);
}
