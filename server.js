const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib'); // For data compression

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 20e6, // Increase buffer size to 20MB
  pingTimeout: 60000, // Increase timeout to 60 seconds
  pingInterval: 25000 // Increase ping interval to 25 seconds
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // For handling large base64 images
app.use(express.static(path.join(__dirname)));

// Data storage - in production, consider using a database
const DRAWINGS_DIR = path.join(__dirname, 'drawings');
const drawings = new Map(); // In-memory cache of drawings

// Compress drawing dataURL to reduce size
function compressDataURL(dataURL) {
  if (!dataURL || dataURL.length < 1000) return dataURL;
  
  try {
    // Just truncate the data for network transfer - full data will be available via API
    return dataURL.substring(0, 100) + '...[compressed, full data available via API]';
  } catch (error) {
    console.error('Error compressing dataURL:', error);
    return dataURL;
  }
}

// Optimize drawing for network transmission
function optimizeDrawingForTransfer(drawing) {
  if (!drawing) return drawing;
  
  return {
    wallKey: drawing.wallKey,
    position: drawing.position,
    normal: drawing.normal,
    size: drawing.size,
    timestamp: drawing.timestamp,
    // Send compressed version of the dataURL for socket transfers
    dataURL: compressDataURL(drawing.dataURL),
    isCompressed: true,
    // Make sure to indicate it uses transparency
    hasTransparency: true 
  };
}

// Create drawings directory if it doesn't exist
function initializeStorage() {
  console.log('Initializing drawing storage...');
  
  // Create drawings directory if it doesn't exist
  if (!fs.existsSync(DRAWINGS_DIR)) {
    console.log(`Creating drawings directory at ${DRAWINGS_DIR}`);
    fs.mkdirSync(DRAWINGS_DIR, { recursive: true });
  }
  
  // Load existing drawings from disk
  try {
    const files = fs.readdirSync(DRAWINGS_DIR);
    console.log(`Found ${files.length} files in drawings directory`);
    
    let loadedCount = 0;
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const filePath = path.join(DRAWINGS_DIR, file);
          const data = fs.readFileSync(filePath, 'utf8');
          const drawing = JSON.parse(data);
          
          // Ensure the drawing has all required fields before adding it
          if (drawing && drawing.wallKey && drawing.dataURL) {
            drawings.set(drawing.wallKey, drawing);
            loadedCount++;
          } else {
            console.warn(`Skipping invalid drawing file: ${file}`);
          }
        } catch (fileError) {
          console.error(`Error loading drawing file ${file}:`, fileError);
        }
      }
    }
    console.log(`Loaded ${loadedCount} drawings from disk`);
  } catch (readError) {
    console.error(`Error reading drawings directory:`, readError);
  }
}

// Save a drawing to disk with optimization
function saveDrawingToDisk(drawing) {
  try {
    // Create a safe filename
    const safeKey = drawing.wallKey.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filePath = path.join(DRAWINGS_DIR, `${safeKey}.json`);
    
    // Keep transparency by ensuring we keep PNG format
    // Add a flag to indicate this drawing should maintain transparency
    const optimizedDrawing = { 
      ...drawing,
      hasTransparency: true
    };
    
    // Save to disk
    fs.writeFileSync(filePath, JSON.stringify(optimizedDrawing));
    console.log(`Drawing saved to ${filePath} (Size: ${optimizedDrawing.dataURL.length} chars)`);
    return true;
  } catch (error) {
    console.error('Error saving drawing to disk:', error);
    return false;
  }
}

// API endpoint to save a drawing
app.post('/api/drawings', (req, res) => {
  try {
    const { wallKey, dataURL, position, normal, size } = req.body;
    
    if (!wallKey || !dataURL) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    console.log(`Saving drawing with key: ${wallKey} (Data size: ${dataURL.length} chars)`);
    
    const drawing = {
      wallKey,
      dataURL,
      position,
      normal,
      size,
      timestamp: new Date().toISOString()
    };
    
    // Save to memory
    drawings.set(wallKey, drawing);
    
    // Save to disk in background to not block the response
    setTimeout(() => saveDrawingToDisk(drawing), 0);
    
    // Send immediate success response first
    res.status(201).json({ success: true });
    
    // Then broadcast to clients with optimized data
    const optimizedDrawing = optimizeDrawingForTransfer(drawing);
    io.emit('drawing-update', optimizedDrawing);
    
  } catch (err) {
    console.error('Error saving drawing:', err);
    res.status(500).json({ error: 'Failed to save drawing' });
  }
});

// Debug endpoint to check server status and drawing count
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    drawingsCount: drawings.size,
    drawingsList: Array.from(drawings.keys())
  });
});

// API endpoint to get all drawings
app.get('/api/drawings', (req, res) => {
  try {
    const drawingsArray = Array.from(drawings.values());
    console.log(`Returning ${drawingsArray.length} drawings`);
    
    // Validate drawings before sending
    const validDrawings = drawingsArray.filter(drawing => {
      const isValid = drawing && drawing.wallKey && drawing.dataURL;
      if (!isValid) {
        console.warn(`Found invalid drawing: ${drawing ? drawing.wallKey : 'undefined'}`);
      }
      return isValid;
    });
    
    console.log(`Filtered to ${validDrawings.length} valid drawings`);
    
    // Send optimized versions of drawings
    const optimizedDrawings = validDrawings.map(optimizeDrawingForTransfer);
    
    // Add a flag indicating these are optimized for transport
    const result = optimizedDrawings.map(drawing => ({
      ...drawing,
      _optimizedForTransport: true
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Error returning drawings:', error);
    res.status(500).json({ error: 'Failed to retrieve drawings' });
  }
});

// API endpoint to get a specific drawing
app.get('/api/drawings/:wallKey', (req, res) => {
  const { wallKey } = req.params;
  const drawing = drawings.get(wallKey);
  
  if (drawing) {
    res.json(drawing);
  } else {
    res.status(404).json({ error: 'Drawing not found' });
  }
});

// API endpoint to get a specific drawing with full data
app.get('/api/drawings/:wallKey/full', (req, res) => {
  const { wallKey } = req.params;
  const drawing = drawings.get(wallKey);
  
  if (drawing) {
    // Add cache control headers to help browser caching
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.json(drawing); // Send the full uncompressed version
  } else {
    console.error(`Drawing not found: ${wallKey}`);
    res.status(404).json({ error: 'Drawing not found' });
  }
});

// Improve the endpoint to check a specific drawing's data
app.get('/api/drawings/:wallKey/debug', (req, res) => {
  const { wallKey } = req.params;
  const drawing = drawings.get(wallKey);
  
  if (drawing) {
    const debugInfo = {
      wallKey: drawing.wallKey,
      hasData: !!drawing.dataURL,
      dataURLLength: drawing.dataURL ? drawing.dataURL.length : 0,
      dataURLStart: drawing.dataURL ? drawing.dataURL.substring(0, 50) + '...' : null,
      dataURLValid: drawing.dataURL ? drawing.dataURL.startsWith('data:image/') : false,
      position: drawing.position,
      normal: drawing.normal,
      timestamp: drawing.timestamp,
    };
    res.json(debugInfo);
  } else {
    res.status(404).json({ error: 'Drawing not found' });
  }
});

// Debug endpoint to list all wall keys
app.get('/api/debug/walls', (req, res) => {
  try {
    const wallKeys = Array.from(drawings.keys());
    res.json({
      count: wallKeys.length,
      walls: wallKeys
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error retrieving wall keys' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  // Send initial drawings gradually to avoid overwhelming
  const drawingsArray = Array.from(drawings.values());
  console.log(`Sending ${drawingsArray.length} drawings to new client in batches`);
  
  // Send in batches of 5 optimized drawings
  const batchSize = 5;
  const optimizedDrawings = drawingsArray.map(optimizeDrawingForTransfer);
  
  // Process each batch
  for (let i = 0; i < optimizedDrawings.length; i += batchSize) {
    const batch = optimizedDrawings.slice(i, i + batchSize);
    setTimeout(() => {
      if (socket.connected) {
        socket.emit('drawing-batch', batch);
      }
    }, i * 100); // Bigger delay between batches to reduce load
  }
  
  // Signal when all drawings have been sent
  setTimeout(() => {
    if (socket.connected) {
      socket.emit('drawings-complete');
    }
  }, (Math.ceil(drawingsArray.length / batchSize) + 1) * 100);
  
  socket.on('new-drawing', (drawing) => {
    if (!drawing || !drawing.wallKey || !drawing.dataURL) {
      console.error('Received invalid drawing data');
      return;
    }
    
    console.log(`Received new drawing via socket with key: ${drawing.wallKey} (size: ${drawing.dataURL.length} chars)`);
    
    try {
      // Save to memory
      drawings.set(drawing.wallKey, drawing);
      
      // Save to disk asynchronously
      setTimeout(() => saveDrawingToDisk(drawing), 0);
      
      // Broadcast to other clients - with reduced data
      const optimizedDrawing = optimizeDrawingForTransfer(drawing);
      socket.broadcast.emit('drawing-update', optimizedDrawing);
      
      // Acknowledge receipt to the sender
      socket.emit('drawing-received', { wallKey: drawing.wallKey });
    } catch (error) {
      console.error('Error processing drawing:', error);
      socket.emit('drawing-error', { 
        wallKey: drawing.wallKey,
        error: 'Server error processing drawing'
      });
    }
  });
  
  // Handle client errors gracefully
  socket.on('error', (error) => {
    console.error('Socket client error:', error);
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
  });
});

// Error handling for server
server.on('error', (error) => {
  console.error('Server error:', error);
});

// Initialize storage before starting server
initializeStorage();

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Drawings stored in ${DRAWINGS_DIR}`);
});
