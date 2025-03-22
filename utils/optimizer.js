/**
 * Drawing optimizer utility for reducing file sizes
 */
const fs = require('fs').promises;
const path = require('path');
const { createCanvas, Image } = require('canvas');

const DRAWINGS_DIR = path.join(__dirname, 'drawings');

/**
 * Optimize a drawing file to reduce its size
 * @param {string} filePath - Path to the drawing JSON file
 */
async function optimizeDrawingFile(filePath) {
  try {
    console.log(`Optimizing drawing: ${filePath}`);
    
    // Read the drawing file
    const data = await fs.readFile(filePath, 'utf8');
    const drawing = JSON.parse(data);
    
    // Check if it has a dataURL to optimize
    if (!drawing.dataURL || !drawing.dataURL.startsWith('data:image/')) {
      console.log(`No image data in ${filePath}`);
      return false;
    }
    
    // Check the size
    const originalSize = drawing.dataURL.length;
    
    // Skip if already small
    if (originalSize < 50000) {
      console.log(`Drawing is already small (${originalSize} bytes)`);
      return false;
    }
    
    // Decode the base64 image
    const matches = drawing.dataURL.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      console.log(`Invalid data URL format`);
      return false;
    }
    
    const imageBuffer = Buffer.from(matches[2], 'base64');
    
    // Load the image
    const img = new Image();
    img.src = imageBuffer;
    
    // Resize to a reasonable size
    const maxSize = 512;
    let width = img.width;
    let height = img.height;
    
    if (width > maxSize || height > maxSize) {
      if (width > height) {
        height = Math.floor(height * (maxSize / width));
        width = maxSize;
      } else {
        width = Math.floor(width * (maxSize / height));
        height = maxSize;
      }
    }
    
    // Create a canvas to draw the resized image
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // IMPORTANT: Clear with transparent background first
    ctx.clearRect(0, 0, width, height);
    
    // Draw the image maintaining transparency
    ctx.drawImage(img, 0, 0, width, height);
    
    // Use PNG format to preserve transparency
    const optimizedDataURL = canvas.toDataURL('image/png', 0.8);
    
    // Update the drawing
    drawing.dataURL = optimizedDataURL;
    drawing.optimized = true;
    
    // Save the optimized drawing
    await fs.writeFile(filePath, JSON.stringify(drawing));
    
    const newSize = drawing.dataURL.length;
    console.log(`Optimized drawing: ${originalSize} -> ${newSize} bytes (${Math.round((1 - newSize/originalSize) * 100)}% reduction)`);
    
    return true;
  } catch (error) {
    console.error(`Error optimizing ${filePath}:`, error);
    return false;
  }
}

/**
 * Optimize all drawings in the drawings directory
 */
async function optimizeAllDrawings() {
  try {
    console.log(`Starting batch optimization of all drawings in ${DRAWINGS_DIR}`);
    
    // Check if directory exists
    let stats;
    try {
      stats = await fs.stat(DRAWINGS_DIR);
      if (!stats.isDirectory()) {
        console.error(`${DRAWINGS_DIR} exists but is not a directory`);
        return;
      }
    } catch (error) {
      console.error(`Drawings directory does not exist: ${error.message}`);
      return;
    }
    
    // Get all JSON files
    const files = await fs.readdir(DRAWINGS_DIR);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    console.log(`Found ${jsonFiles.length} drawing files`);
    
    let optimizedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    
    // Process each file
    for (const file of jsonFiles) {
      const filePath = path.join(DRAWINGS_DIR, file);
      
      try {
        const wasOptimized = await optimizeDrawingFile(filePath);
        if (wasOptimized) {
          optimizedCount++;
        } else {
          skippedCount++;
        }
      } catch (error) {
        console.error(`Failed to optimize ${file}:`, error);
        failedCount++;
      }
    }
    
    console.log(`
Optimization complete:
- Optimized: ${optimizedCount} files
- Skipped: ${skippedCount} files
- Failed: ${failedCount} files
`);
  } catch (error) {
    console.error('Error during batch optimization:', error);
  }
}

// If called directly from command line
if (require.main === module) {
  optimizeAllDrawings()
    .then(() => console.log('Optimization completed'))
    .catch(err => console.error('Optimization failed:', err));
}

module.exports = {
  optimizeDrawingFile,
  optimizeAllDrawings
};
