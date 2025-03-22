/**
 * Utility script to fix transparency issues in drawings
 * Run with: node transparencyFix.js
 */

const fs = require('fs').promises;
const path = require('path');
const { createCanvas, Image } = require('canvas');

const DRAWINGS_DIR = path.join(__dirname, 'drawings');

/**
 * Fix transparency issues in a drawing file
 * @param {string} filePath - Path to the drawing JSON file
 */
async function fixTransparency(filePath) {
  try {
    console.log(`Fixing transparency for: ${filePath}`);
    
    // Read the drawing file
    const data = await fs.readFile(filePath, 'utf8');
    const drawing = JSON.parse(data);
    
    // Check if it has a dataURL to fix
    if (!drawing.dataURL || !drawing.dataURL.startsWith('data:image/')) {
      console.log(`No image data in ${filePath}`);
      return false;
    }
    
    // Skip if already processed
    if (drawing.transparencyFixed) {
      console.log(`Drawing already processed: ${filePath}`);
      return false;
    }
    
    // Decode the base64 image
    const matches = drawing.dataURL.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      console.log(`Invalid data URL format`);
      return false;
    }
    
    // Check if it's already PNG (likely has transparency)
    const mimeType = matches[1];
    if (mimeType === 'image/png') {
      drawing.transparencyFixed = true;
      drawing.hasTransparency = true;
      await fs.writeFile(filePath, JSON.stringify(drawing));
      console.log(`Drawing already uses PNG format: ${filePath}`);
      return false;
    }
    
    // It's not PNG, let's convert it
    const imageBuffer = Buffer.from(matches[2], 'base64');
    
    // Load the image
    const img = new Image();
    img.src = imageBuffer;
    
    // Create a canvas with the same dimensions
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    
    // Clear with transparent background
    ctx.clearRect(0, 0, img.width, img.height);
    
    // Draw the image
    ctx.drawImage(img, 0, 0);
    
    // Convert to PNG with transparency
    const transparentDataURL = canvas.toDataURL('image/png');
    
    // Update the drawing
    drawing.dataURL = transparentDataURL;
    drawing.transparencyFixed = true;
    drawing.hasTransparency = true;
    
    // Save the fixed drawing
    await fs.writeFile(filePath, JSON.stringify(drawing));
    console.log(`Fixed transparency for: ${filePath}`);
    
    return true;
  } catch (error) {
    console.error(`Error fixing transparency in ${filePath}:`, error);
    return false;
  }
}

/**
 * Process all drawings in the directory
 */
async function fixAllDrawings() {
  try {
    console.log(`Starting transparency fix for all drawings in ${DRAWINGS_DIR}`);
    
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
    
    let fixedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    
    // Process each file
    for (const file of jsonFiles) {
      const filePath = path.join(DRAWINGS_DIR, file);
      
      try {
        const wasFixed = await fixTransparency(filePath);
        if (wasFixed) {
          fixedCount++;
        } else {
          skippedCount++;
        }
      } catch (error) {
        console.error(`Failed to fix ${file}:`, error);
        failedCount++;
      }
    }
    
    console.log(`
Transparency fix complete:
- Fixed: ${fixedCount} files
- Skipped: ${skippedCount} files
- Failed: ${failedCount} files
`);
  } catch (error) {
    console.error('Error during transparency fix:', error);
  }
}

// Execute when called directly
if (require.main === module) {
  fixAllDrawings()
    .then(() => console.log('Transparency fix completed'))
    .catch(err => console.error('Transparency fix failed:', err));
}

module.exports = {
  fixTransparency,
  fixAllDrawings
};
