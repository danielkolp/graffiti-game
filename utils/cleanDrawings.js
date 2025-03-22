/**
 * Utility script to clean up the drawings directory
 * Run with: node cleanDrawings.js
 */

const fs = require('fs').promises;
const path = require('path');

const DRAWINGS_DIR = path.join(__dirname, 'drawings');

async function cleanDrawings() {
  try {
    console.log(`Cleaning drawings directory: ${DRAWINGS_DIR}`);
    
    // Check if directory exists
    try {
      await fs.access(DRAWINGS_DIR);
    } catch (err) {
      console.log('Drawings directory does not exist. Creating it...');
      await fs.mkdir(DRAWINGS_DIR, { recursive: true });
      console.log('Drawings directory created. No files to delete.');
      return;
    }
    
    // Read all files
    const files = await fs.readdir(DRAWINGS_DIR);
    console.log(`Found ${files.length} files`);
    
    if (files.length === 0) {
      console.log('No files to delete.');
      return;
    }
    
    // Delete all files
    let deletedCount = 0;
    for (const file of files) {
      const filePath = path.join(DRAWINGS_DIR, file);
      await fs.unlink(filePath);
      deletedCount++;
      console.log(`Deleted: ${file}`);
    }
    
    console.log(`Successfully deleted ${deletedCount} files.`);
  } catch (err) {
    console.error('Error cleaning drawings directory:', err);
  }
}

// Execute the cleaning function
cleanDrawings();
