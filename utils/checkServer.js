/**
 * Utility script to check server status and drawings
 * Run with: node checkServer.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const DRAWINGS_DIR = path.join(__dirname, 'drawings');
const SERVER_URL = 'http://localhost:3000/api/status';

// Check server status
function checkServerStatus() {
  return new Promise((resolve, reject) => {
    http.get(SERVER_URL, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const status = JSON.parse(data);
            resolve(status);
          } catch (error) {
            reject(new Error(`Error parsing server response: ${error.message}`));
          }
        } else {
          reject(new Error(`Server returned status code ${res.statusCode}`));
        }
      });
    }).on('error', (error) => {
      reject(new Error(`Server connection error: ${error.message}`));
    });
  });
}

// Check drawings directory
function checkDrawingsDirectory() {
  console.log(`Checking drawings directory: ${DRAWINGS_DIR}`);
  
  if (!fs.existsSync(DRAWINGS_DIR)) {
    console.log('Drawings directory does not exist.');
    return;
  }
  
  // Read all files
  const files = fs.readdirSync(DRAWINGS_DIR);
  console.log(`Found ${files.length} files in drawings directory`);
  
  // Show some details about each file
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const filePath = path.join(DRAWINGS_DIR, file);
        const stats = fs.statSync(filePath);
        const fileSizeKB = stats.size / 1024;
        
        // Read and parse the file
        const data = fs.readFileSync(filePath, 'utf8');
        const drawing = JSON.parse(data);
        
        console.log(`File: ${file} | Size: ${fileSizeKB.toFixed(2)} KB | WallKey: ${drawing.wallKey} | Timestamp: ${drawing.timestamp || 'N/A'}`);
      } catch (error) {
        console.error(`Error reading file ${file}: ${error.message}`);
      }
    }
  }
}

// Main function
async function main() {
  console.log('Checking drawing server status...');
  
  // Check server status
  try {
    const status = await checkServerStatus();
    console.log('Server status:', status);
  } catch (error) {
    console.error('Failed to check server status:', error.message);
    console.log('Make sure the server is running (npm start)');
  }
  
  // Check drawings directory
  checkDrawingsDirectory();
}

// Run the main function
main();
