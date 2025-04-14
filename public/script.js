import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { io } from "https://cdn.socket.io/4.7.2/socket.io.esm.min.js";

// Define socket-related variables at the top level before ANY function uses them
let socket = null;
let serverConnected = false;
let pendingDrawings = new Map(); // Track drawings being saved

// Scene setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Sky blue background
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 10, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Camera and controls variablesw
let cameraOrbitControls;
let lastCameraInteractionTime = Date.now();

// Controls for debugging
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Create debug UI elements
const debugElement = document.createElement('div');
debugElement.style.position = 'absolute';
debugElement.style.bottom = '10px';
debugElement.style.left = '10px';
debugElement.style.color = 'white';
debugElement.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
debugElement.style.padding = '10px';
debugElement.style.fontFamily = 'Arial, sans-serif';
debugElement.style.fontSize = '14px';
debugElement.style.zIndex = '1000';
debugElement.innerText = 'Initializing scene...';
document.body.appendChild(debugElement);

// Wall drawing system UI
const drawPromptElement = document.createElement('div');
drawPromptElement.style.position = 'absolute';
drawPromptElement.style.bottom = '50px'; // Moved further down to the bottom
drawPromptElement.style.left = '50%';
drawPromptElement.style.transform = 'translateX(-50%)';
drawPromptElement.style.padding = '0';
drawPromptElement.style.borderRadius = '0';
drawPromptElement.style.backgroundColor = 'transparent';
drawPromptElement.style.fontFamily = 'Arial, sans-serif';
drawPromptElement.style.fontSize = '16px';
drawPromptElement.style.zIndex = '1000';
drawPromptElement.style.display = 'none';
// Make the image much smaller
drawPromptElement.innerHTML = '<img src="assets/pressE.png" alt="Press E to draw" style="width: 300px; height: auto; display: block;">'; 
document.body.appendChild(drawPromptElement);

// Drawing canvas setup
const drawingCanvas = document.createElement('canvas');
drawingCanvas.style.position = 'absolute';
drawingCanvas.style.top = '0';
drawingCanvas.style.left = '0';
drawingCanvas.style.width = '100%';
drawingCanvas.style.height = '100%';
drawingCanvas.style.zIndex = '1001';
drawingCanvas.style.display = 'none';
drawingCanvas.style.cursor = 'crosshair';
document.body.appendChild(drawingCanvas);
const ctx = drawingCanvas.getContext('2d');

// Drawing controls UI
const drawingControlsElement = document.createElement('div');
drawingControlsElement.style.position = 'absolute';
drawingControlsElement.style.bottom = '10px';
drawingControlsElement.style.right = '10px';
drawingControlsElement.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
drawingControlsElement.style.padding = '10px';
drawingControlsElement.style.borderRadius = '5px';
drawingControlsElement.style.fontFamily = 'Arial, sans-serif';
drawingControlsElement.style.zIndex = '1002';
drawingControlsElement.style.display = 'none';
drawingControlsElement.innerHTML = `
  <button id="save-drawing">Save</button>
  <button id="cancel-drawing">Cancel</button>
  <input type="color" id="color-picker" value="#ff0000">
  <input type="range" id="brush-size" min="1" max="20" value="5">
  <div style="margin-top: 5px;">
    <button id="brush-tool" class="tool-btn selected">Brush</button>
    <button id="fill-tool" class="tool-btn">Fill</button>
  </div>
`;
document.body.appendChild(drawingControlsElement);

// Add some basic styles for the tool buttons
const styleElement = document.createElement('style');
styleElement.textContent = `
  .tool-btn {
    padding: 3px 10px;
    margin-right: 5px;
    background-color: #555;
    border: none;
    color: white;
    border-radius: 3px;
    cursor: pointer;
  }
  .tool-btn.selected {
    background-color: #00a8ff;
  }
`;
document.head.appendChild(styleElement);

// Wall drawing system variables
let isLookingAtWall = false;
let currentWall = null;
let isDrawing = false;
let isDrawMode = false;
let drawings = new Map(); // To store drawings for each wall
let drawingState = {
  color: '#ff0000',
  size: 5,
  lastX: 0,
  lastY: 0,
  tool: 'brush' // Add tool property to track current tool
};
// Store created decals for later management
let wallDecals = [];

// Create a placement indicator for the drawing using Three.js
// Instead of using an HTML element, we'll use a 3D decal for more accurate preview
let placementDecal = null; // Will hold the preview decal mesh
let previewMaterial = null; // Material for the preview decal

// Create the preview material once
function createPreviewMaterial() {
  // Create a canvas for the preview texture
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  
  // Draw a semi-transparent frame with a grid pattern
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Add a border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  
  // Add grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  
  // Vertical lines
  for (let x = 32; x < canvas.width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  
  // Horizontal lines
  for (let y = 32; y < canvas.height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  
  // Create a texture from the canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  
  // Create the material
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.8,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    side: THREE.DoubleSide
  });
}

// Update the placement indicator position using Three.js raycaster and decals
function updatePlacementIndicator() {
  if (!currentWall || !camera) return;
  
  // Create the preview material if it doesn't exist yet
  if (!previewMaterial) {
    previewMaterial = createPreviewMaterial();
  }
  
  // Remove existing placement decal if it exists
  if (placementDecal) {
    scene.remove(placementDecal);
    placementDecal = null;
  }
  
  // Get the intersection point from either mouse positioning or camera center
  let intersectionPoint = currentWall.point.clone();
  
  // If mouse positioning is enabled, use a raycaster to find where the mouse is pointing
  if (isMousePositioningEnabled && lastMousePosition) {
    // Convert mouse position to normalized device coordinates (-1 to +1)
    const mouseX = (lastMousePosition.x / window.innerWidth) * 2 - 1;
    const mouseY = -(lastMousePosition.y / window.innerHeight) * 2 + 1;
    
    // Set up the raycaster from the camera through the mouse position
    mouseRaycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);
    
    // Check for intersections with the current wall
    const intersects = mouseRaycaster.intersectObject(currentWall.object);
    
    // If we found an intersection with the wall, use that position
    if (intersects.length > 0) {
      intersectionPoint = intersects[0].point.clone();
    }
  }
  
  // Get the normal of the wall
  const normal = currentWall.normal.clone().normalize();
  
  // Choose a temporary up vector that isn't parallel to the normal
  const tempUp = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  
  // Create orientation vectors
  const right = new THREE.Vector3().crossVectors(tempUp, normal).normalize();
  const up = new THREE.Vector3().crossVectors(normal, right).normalize();
  
  // Create orientation from these vectors
  const orientation = new THREE.Euler().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, normal)
  );
  
  // Slightly offset the decal from the wall to prevent z-fighting
  const position = intersectionPoint.clone().add(normal.clone().multiplyScalar(0.01));
  
  // Create decal size - a square for now, we'll use the aspect ratio of the actual drawing when saving
  const size = new THREE.Vector3(4, 4, 0.5); 
  
  try {
    // Create the decal geometry
    const decalGeometry = new DecalGeometry(currentWall.object, position, orientation, size);
    
    // Create the placement decal mesh
    placementDecal = new THREE.Mesh(decalGeometry, previewMaterial);
    placementDecal.renderOrder = 2; // Ensure it renders on top of other decals
    
    // Add the decal to the scene
    scene.add(placementDecal);
    
    // Store the current placement for later use when saving
    drawingOffset = {
      x: isMousePositioningEnabled && lastMousePosition ? 
        lastMousePosition.x - window.innerWidth/2 : 0,
      y: isMousePositioningEnabled && lastMousePosition ? 
        lastMousePosition.y - window.innerHeight/2 : 0
    };
  } catch (e) {
    console.error("Failed to create placement decal:", e);
  }
}

// Wall drawings container - we'll add drawings as HTML elements here
const wallDrawingsContainer = document.createElement('div');
wallDrawingsContainer.style.position = 'absolute';
wallDrawingsContainer.style.top = '0';
wallDrawingsContainer.style.left = '0';
wallDrawingsContainer.style.width = '100%';
wallDrawingsContainer.style.height = '100%';
wallDrawingsContainer.style.pointerEvents = 'none';
wallDrawingsContainer.style.zIndex = '998';
document.body.appendChild(wallDrawingsContainer);

// Setup raycaster for wall detection from character's perspective
const wallRaycaster = new THREE.Raycaster();
const mouseRaycaster = new THREE.Raycaster();
const centerScreen = new THREE.Vector2(0, 0);

// Add variables for mouse positioning
let isMousePositioningEnabled = true; // Enable by default
let lastMousePosition = null;
let drawingOffset = { x: 0, y: 0 };

// Add mouse movement tracking for wall drawing placement
document.addEventListener('mousemove', (e) => {
  // Store the current mouse position
  lastMousePosition = {
    x: e.clientX,
    y: e.clientY
  };
  
  // Update placement indicator if we're looking at a wall
  if (isLookingAtWall && !isDrawMode) {
    updatePlacementIndicator();
  }
});

// Add key handler for toggling mouse positioning mode
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 't') {
    isMousePositioningEnabled = !isMousePositioningEnabled;
    
    // Show feedback to the user
    const statusMsg = isMousePositioningEnabled ? 
      "Mouse positioning enabled" : 
      "Mouse positioning disabled";
    
    const feedback = document.createElement('div');
    feedback.textContent = statusMsg;
    feedback.style.position = 'absolute';
    feedback.style.top = '50%';
    feedback.style.left = '50%';
    feedback.style.transform = 'translate(-50%, -50%)';
    feedback.style.backgroundColor = 'rgba(0,0,0,0.7)';
    feedback.style.color = 'white';
    feedback.style.padding = '10px';
    feedback.style.borderRadius = '5px';
    feedback.style.zIndex = '1010';
    document.body.appendChild(feedback);
    
    // Remove the feedback after 2 seconds
    setTimeout(() => {
      document.body.removeChild(feedback);
    }, 2000);
    
    // Update placement immediately
    if (isLookingAtWall) {
      updatePlacementIndicator();
    }
  }
});

// Setup drawing functionality
function initDrawingSystem() {
  // Resize canvas to match window
  function resizeCanvas() {
    drawingCanvas.width = window.innerWidth;
    drawingCanvas.height = window.innerHeight;
    
    // Clear the canvas with a transparent background instead of white
    ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    // Use a semi-transparent background to indicate drawing area without making it part of the drawing
    ctx.fillStyle = 'rgba(128, 128, 128, 0.0)';
    ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    
    // Setup drawing context
    ctx.strokeStyle = drawingState.color;
    ctx.lineWidth = drawingState.size;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }
  
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  
  // Drawing event listeners - updated to handle different tools
  drawingCanvas.addEventListener('mousedown', handleCanvasMouseDown);
  drawingCanvas.addEventListener('mousemove', handleCanvasMouseMove);
  drawingCanvas.addEventListener('mouseup', stopDrawing);
  drawingCanvas.addEventListener('mouseout', stopDrawing);
  
  // Drawing controls
  document.getElementById('color-picker').addEventListener('change', (e) => {
    drawingState.color = e.target.value;
    ctx.strokeStyle = drawingState.color;
  });
  
  document.getElementById('brush-size').addEventListener('input', (e) => {
    drawingState.size = e.target.value;
    ctx.lineWidth = drawingState.size;
  });
  
  // Tool selection buttons
  document.getElementById('brush-tool').addEventListener('click', (e) => {
    selectTool('brush', e.target);
  });
  
  document.getElementById('fill-tool').addEventListener('click', (e) => {
    selectTool('fill', e.target);
  });
  
  document.getElementById('save-drawing').addEventListener('click', saveDrawing);
  document.getElementById('cancel-drawing').addEventListener('click', cancelDrawing);
}

// Handle mouse down on canvas based on selected tool
function handleCanvasMouseDown(e) {
  if (drawingState.tool === 'brush') {
    startDrawing(e);
  } else if (drawingState.tool === 'fill') {
    floodFill(e.offsetX, e.offsetY, drawingState.color);
  }
}

// Handle mouse move on canvas based on selected tool
function handleCanvasMouseMove(e) {
  if (drawingState.tool === 'brush' && isDrawing) {
    draw(e);
  }
}

// Helper function to select a drawing tool
function selectTool(toolName, buttonElement) {
  drawingState.tool = toolName;
  
  // Update button styles
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.remove('selected');
  });
  
  buttonElement.classList.add('selected');
  
  // Update cursor based on tool
  if (toolName === 'brush') {
    drawingCanvas.style.cursor = 'crosshair';
  } else if (toolName === 'fill') {
    drawingCanvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cpath fill=\'white\' d=\'M16.56 8.94L7.62 0 6.21 1.41l2.38 2.38-5.15 5.15c-.59.59-.59 1.54 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10L10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5z\'/%3E%3C/svg%3E") 0 24, pointer';
  }
}

// Implement flood fill algorithm for the fill tool
function floodFill(startX, startY, fillColor) {
  // Get the canvas image data
  const imageData = ctx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height);
  const data = imageData.data;
  const width = drawingCanvas.width;
  const height = drawingCanvas.height;
  
  // Get the color at the start position (RGBA)
  const startPos = (startY * width + startX) * 4;
  const startR = data[startPos];
  const startG = data[startPos + 1];
  const startB = data[startPos + 2];
  const startA = data[startPos + 3];
  
  // Parse the fill color from hex to RGB
  const fillColorObj = hexToRgba(fillColor);
  
  // If the target color is the same as fill color, do nothing
  if (
    startR === fillColorObj.r && 
    startG === fillColorObj.g && 
    startB === fillColorObj.b && 
    startA === 255
  ) {
    return;
  }
  
  // Use a queue for the flood fill to avoid stack overflow
  const pixelsToCheck = [];
  pixelsToCheck.push([startX, startY]);
  
  // Set a limit to prevent slow filling of very large areas
  const maxPixels = width * height * 0.5; // Max 50% of canvas
  let processedPixels = 0;
  
  // Process pixels while there are pixels in the queue and we haven't hit the limit
  while (pixelsToCheck.length > 0 && processedPixels < maxPixels) {
    const [x, y] = pixelsToCheck.pop();
    processedPixels++;
    
    // Calculate position in the pixel array
    const pixelPos = (y * width + x) * 4;
    
    // If not in canvas, skip
    if (x < 0 || y < 0 || x >= width || y >= height) {
      continue;
    }
    
    // If this pixel doesn't match the target color, skip
    if (
      data[pixelPos] !== startR || 
      data[pixelPos + 1] !== startG || 
      data[pixelPos + 2] !== startB || 
      data[pixelPos + 3] !== startA
    ) {
      continue;
    }
    
    // Fill the pixel
    data[pixelPos] = fillColorObj.r;
    data[pixelPos + 1] = fillColorObj.g;
    data[pixelPos + 2] = fillColorObj.b;
    data[pixelPos + 3] = 255; // Fully opaque
    
    // Check adjacent pixels (4-way connectivity)
    pixelsToCheck.push([x + 1, y]);
    pixelsToCheck.push([x - 1, y]);
    pixelsToCheck.push([x, y + 1]);
    pixelsToCheck.push([x, y - 1]);
  }
  
  // Apply the changed pixels back to the canvas
  ctx.putImageData(imageData, 0, 0);
}

// Helper function to convert hex color to rgba values
function hexToRgba(hex) {
  // Remove # if present
  hex = hex.replace('#', '');
  
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
    a: 255 // Full opacity
  };
}

// Start drawing mode
function enterDrawMode() {
  if (!isLookingAtWall || !currentWall) return;
  
  isDrawMode = true;
  
  // Disable controls
  cameraOrbitControls.enabled = false;
  
  // Store the current drawing offset and position based on the 3D placement indicator
  if (placementDecal) {
    // Get the position of the placement decal to use as the drawing position
    drawingOffset = {
      x: isMousePositioningEnabled && lastMousePosition ? 
          lastMousePosition.x - window.innerWidth/2 : 0,
      y: isMousePositioningEnabled && lastMousePosition ? 
          lastMousePosition.y - window.innerHeight/2 : 0
    };
    
    // Hide the placement decal
    scene.remove(placementDecal);
    placementDecal = null;
  }
  
  // Show drawing canvas and controls
  drawingCanvas.style.display = 'block';
  drawingControlsElement.style.display = 'block';
  drawPromptElement.style.display = 'none';
  
  // Use a transparent background for the drawing canvas
  ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  // Semi-transparent gray to show the drawing area without affecting the actual drawing
  ctx.fillStyle = 'rgba(128, 128, 128, 0.0)';
  ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  
  // Set drawing color and properties
  ctx.strokeStyle = drawingState.color;
  ctx.lineWidth = drawingState.size;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  
  // Set the default tool
  selectTool('brush', document.getElementById('brush-tool'));
}

// Exit drawing mode
function exitDrawMode() {
  isDrawMode = false;
  
  // Re-enable controls
  cameraOrbitControls.enabled = true;
  
  // Hide drawing canvas and controls
  drawingCanvas.style.display = 'none';
  drawingControlsElement.style.display = 'none';
}

// Helper function to resize/optimize image data before sending
function optimizeDrawingDataURL(dataURL) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = function() {
        // Calculate new dimensions - make smaller for network transfer
        const maxSize = 512;
        let width = img.width;
        let height = img.height;
        
        // Resize if too large
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.floor(height * (maxSize / width));
            width = maxSize;
          } else {
            width = Math.floor(width * (maxSize / height));
            height = maxSize;
          }
        }
        
        // Create a smaller version
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // IMPORTANT: Clear with transparent background
        ctx.clearRect(0, 0, width, height);
        
        // Draw the image maintaining transparency
        ctx.drawImage(img, 0, 0, width, height);
        
        // Always use PNG for transparency
        resolve(canvas.toDataURL('image/png', 0.8));
      };
      
      img.onerror = function() {
        console.error('Failed to load image for optimization');
        resolve(dataURL); // Return original if optimization fails
      };
      
      img.src = dataURL;
    } catch (error) {
      console.error('Error optimizing image:', error);
      resolve(dataURL); // Return original if optimization fails
    }
  });
}

// Save the drawing and apply it to the wall
async function saveDrawing() {
  if (!currentWall) return;
  
  try {
    // Generate a unique key for this wall
    const wallKey = getWallKey(currentWall);
    
    // Remove any existing decal for this wall
  
    
    // Create a temporary canvas for the actual drawing with transparent background
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = drawingCanvas.width;
    tempCanvas.height = drawingCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    
    // CRUCIAL: Ensure the background is transparent by NOT filling it
    // Just clear the canvas to make it transparent
    tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    // Copy only the drawings to the temp canvas
    tempCtx.drawImage(drawingCanvas, 0, 0);
    
    // Get the drawing data URL with transparency
    const dataURL = tempCanvas.toDataURL('image/png');
    
    // Apply the drawing to the wall as a decal before uploading
    const adjustedWall = {
      ...currentWall,
      point: calculateAdjustedPosition(currentWall, drawingOffset)
    };
    
    // Apply drawing locally immediately
    applyDrawingToWall(adjustedWall, dataURL);
    
    // Show saving indicator
    showNotification("Optimizing and saving drawing...");
    
    // Optimize the image before sending
    const optimizedDataURL = await optimizeDrawingDataURL(dataURL);
    
    // Prepare drawing data for the server
    const drawingData = {
      wallKey,
      dataURL: optimizedDataURL, // Send optimized version
      position: {
        x: adjustedWall.point.x,
        y: adjustedWall.point.y,
        z: adjustedWall.point.z
      },
      normal: {
        x: currentWall.normal.x,
        y: currentWall.normal.y,
        z: currentWall.normal.z
      },
      size: {
        x: 4, // Default size
        y: 4,
        z: 0.5
      },
      timestamp: new Date().toISOString(),
      clientId: socket && socket.connected ? socket.id : 'offline-user', // Check if socket exists
    };
    
    // Add to pending drawings map to track sending status
    pendingDrawings.set(wallKey, drawingData);
    
    // If connected to server, send the drawing
    if (serverConnected && socket && socket.connected) {
      console.log(`Sending drawing to server via socket: ${wallKey} (${optimizedDataURL.length} bytes)`);
      socket.emit('new-drawing', drawingData);
    }
    
    // Always try to save via the REST API too as a backup
    fetch(`${BACKEND_URL}/api/drawings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drawingData)
    })
    .then(response => {
      if (response.ok) {
        console.log('Drawing saved to server successfully via API');
        window.updateConnectionStatus(true);
        pendingDrawings.delete(wallKey);
        showNotification("Drawing saved successfully!", "success");
      } else {
        console.error('Failed to save drawing to server:', response.statusText);
        showNotification("Failed to save drawing to server.", "error");
      }
    })
    .catch(err => {
      console.error('Error saving drawing to server:', err);
      showNotification("Connection error. Drawing saved locally.", "warning");
    });
  } catch (error) {
    console.error("Error saving drawing:", error);
    showNotification("Error saving drawing", "error");
  } finally {
    // Exit drawing mode
    exitDrawMode();
  }
}

// Cancel drawing without saving
function cancelDrawing() {
  exitDrawMode();
}

// Apply the drawing to the wall as an overlay
function applyDrawingToWall(wall, dataURL) {
    const wallKey = getWallKey(wall);
    console.log(`Applying drawing to wall: ${wallKey}`);
   

    // Validate the dataURL to avoid loading errors
    if (!dataURL || typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
        console.error(`Invalid dataURL for ${wallKey}:`, dataURL);
        showNotification("Invalid image data", "error");
        return;
    }
    
    // Check if this is a compressed dataURL that we shouldn't attempt to load
    if (dataURL.includes('[compressed') || dataURL.includes('[...]')) {
        console.error(`Compressed dataURL passed directly to applyDrawingToWall for ${wallKey}`);
        showNotification(`Error: Compressed URL not loadable`, "error");
        return;
    }

    const texture = new THREE.Texture();
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true, // Enable transparency
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        side: THREE.DoubleSide,
        opacity: 1.0,
        alphaTest: 0.001 // Use alphaTest instead of alpha blending for better results
    });

    const image = new Image();
    image.crossOrigin = 'Anonymous'; // Add this to avoid CORS issues
    
    image.onload = function () {
        console.log(`Image loaded for drawing ${wallKey}, size: ${image.width}x${image.height}`);
        texture.image = image;
        texture.needsUpdate = true;

        const aspect = image.width / image.height;
        const baseSize = 4;
        const height = baseSize;
        const width = baseSize * aspect;

        const size = new THREE.Vector3(width, height, 0.5);

        const normal = wall.normal.clone().normalize();

        // Choose a temporary up vector that isn't parallel to the normal
        const tempUp = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);

        const right = new THREE.Vector3().crossVectors(tempUp, normal).normalize();
        const up = new THREE.Vector3().crossVectors(normal, right).normalize();

        const orientation = new THREE.Euler().setFromRotationMatrix(
            new THREE.Matrix4().makeBasis(right, up, normal)
        );

        const position = wall.point.clone().add(normal.clone().multiplyScalar(0.05)); // small offset out from the wall

        try {
            console.log(`Creating decal geometry at position:`, position);
            const decalGeometry = new DecalGeometry(wall.object, position, orientation, size);
            const decalMesh = new THREE.Mesh(decalGeometry, material);
            decalMesh.userData.wallKey = wallKey;
            
            // Make decal slightly more visible for debugging
            decalMesh.renderOrder = 1; // Ensure it renders on top

            scene.add(decalMesh);
            wallDecals.push(decalMesh);
            
            console.log(`Drawing applied to wall ${wallKey} successfully`);

            drawings.set(wallKey, {
                decalMesh,
                dataURL,
                position: position.clone(),
                normal: normal.clone(),
                size: size.clone()
            });
            
            // Add a short-lived highlight for the new decal for debugging
            const highlightMaterial = decalMesh.material.clone();
            highlightMaterial.color.set(0xff0000); // Red highlight
            highlightMaterial.opacity = 0.5;
            decalMesh.material = highlightMaterial;
            
            // Restore original material after 3 seconds
            setTimeout(() => {
                if (decalMesh.parent) { // Check if still in scene
                    decalMesh.material = material;
                }
            }, 3000);
            
        } catch (e) {
            console.error("Failed to create decal:", e);
            showNotification("Error creating drawing decal", "error");
        }
    };

    image.onerror = function(err) {
        console.error(`Error loading image for drawing ${wallKey}:`, err);
        showNotification("Error loading image", "error");
        
        // Make an error placeholder instead so we show something
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        
        // Red error indicator
        ctx.fillStyle = 'rgba(255, 200, 200, 0.8)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 8;
        ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
        
        // Error text
        ctx.fillStyle = '#dd0000';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Error Loading Image', canvas.width/2, canvas.height/2 - 10);
        ctx.font = '16px Arial';
        ctx.fillText(wallKey, canvas.width/2, canvas.height/2 + 20);
        
        // Try again with this error image
        const errorImageURL = canvas.toDataURL('image/png');
        
        // Create a new image with the error placeholder
        const errorImage = new Image();
        errorImage.onload = image.onload; // Reuse the onload handler
        errorImage.src = errorImageURL;
    };

    console.log(`Setting image source for ${wallKey}, dataURL length: ${dataURL.length}`);
    image.src = dataURL;
}



// Update all wall drawings positions when camera moves
function updateDrawingsPositions() {
  if (!camera) return;
  
  // Get all drawing elements
  const drawingElements = wallDrawingsContainer.querySelectorAll('img');
  
  drawingElements.forEach(element => {
    // Reconstruct the 3D position from dataset
    const position = new THREE.Vector3(
      parseFloat(element.dataset.positionX),
      parseFloat(element.dataset.positionY),
      parseFloat(element.dataset.positionZ)
    );
    
    // Check if the drawing is visible (in front of the camera)
    const direction = position.clone().sub(camera.position);
    const dot = direction.normalize().dot(camera.getWorldDirection(new THREE.Vector3()));
    
    if (dot < 0) {
      // Drawing is behind the camera, hide it
      element.style.display = 'none';
      return;
    }
    
    // Calculate distance to determine size
    const distanceFromCamera = camera.position.distanceTo(position);
    const size = Math.min(300, 200 / (distanceFromCamera * 0.1));
    
    // Project the drawing position to screen coordinates
    const vector = position.clone().project(camera);
    
    // Convert to screen coordinates
    const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-(vector.y * 0.5) + 0.5) * window.innerHeight;
    
    // Update size and position
    element.style.display = 'block';
    element.style.width = size + 'px';
    element.style.height = size + 'px';
    element.style.left = (x - size/2) + 'px';
    element.style.top = (y - size/2) + 'px';
    
    // Add depth scaling for perspective effect (optional)
    const scale = 1 / (distanceFromCamera * 0.1);
    element.style.transform = `scale(${scale})`;
    element.style.opacity = Math.min(1, 2 / distanceFromCamera);
  });
}

function getWallKey(wall) {
    return `wall_${wall.object.id}_${wall.faceIndex}`;
}
// Drawing functions
function startDrawing(e) {
  isDrawing = true;
  drawingState.lastX = e.offsetX;
  drawingState.lastY = e.offsetY;
}

function draw(e) {
  if (!isDrawing) return;
  
  // Set globalAlpha to 1 for maximum opacity
  ctx.globalAlpha = 1.0;
  
  // Draw the line with the current stroke style
  ctx.beginPath();
  ctx.moveTo(drawingState.lastX, drawingState.lastY);
  ctx.lineTo(e.offsetX, e.offsetY);
  ctx.stroke();
  
  drawingState.lastX = e.offsetX;
  drawingState.lastY = e.offsetY;
}

function stopDrawing() {
  isDrawing = false;
}

// Create a crosshair to help with aiming at walls
function createCrosshair() {
  const crosshair = document.createElement('div');
  crosshair.style.position = 'absolute';
  crosshair.style.top = '50%';
  crosshair.style.left = '50%';
  crosshair.style.width = '10px';
  crosshair.style.height = '10px';
  crosshair.style.border = '1px solid white';
  crosshair.style.borderRadius = '50%';
  crosshair.style.transform = 'translate(-50%, -50%)';
  crosshair.style.pointerEvents = 'none';
  crosshair.style.zIndex = '900';
  document.body.appendChild(crosshair);
}

// Create a loading manager to track progress and handle errors
const loadingManager = new THREE.LoadingManager(
    // onLoad
    () => {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
        debugElement.innerText = 'Model loaded successfully';
    },
    // onProgress
    (url, itemsLoaded, itemsTotal) => {
        const progress = Math.round((itemsLoaded / itemsTotal) * 100);
        const loadingText = document.getElementById('loading-text');
        if (loadingText) {
            loadingText.innerText = `Loading model: ${progress}%`;
        }
    },
    // onError
    (url) => {
        debugElement.innerText = `Error loading: ${url}`;
        console.error(`Error loading: ${url}`);
        // Fall back to simple character if model fails to load
        createSimpleCharacter();
    }
);

// Simplified Lighting
function setupLights() {
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    
    // Directional light (sun)
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    scene.add(directionalLight);
}

// Create a simple plane for walking
function createPlane() {
    const planeGeometry = new THREE.PlaneGeometry(1000, 1000);
    const planeMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x999999, // Olive green
        roughness: 0.8
    });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2; // Rotate to be horizontal
    plane.receiveShadow = true;
    scene.add(plane);
   
    // Add grid helper for better visual reference
   
    
}

// Loading City.glb
const loader = new GLTFLoader(loadingManager);
// Create a collection to store collidable objects
let collidableObjects = [];

loader.load(
    '../City.glb',
    (gltf) => {
        console.log("GLB model loaded successfully:", gltf);
        
        // Add the loaded model to the scene
        scene.add(gltf.scene);
        gltf.scene.scale.set(40, 40, 40);
        
        // Adjust the city's position to be slightly higher to prevent clipping
        gltf.scene.position.y = 0.05; // Small offset to prevent ground clipping with character

        // Process all meshes in the city for collision and fix material issues
        gltf.scene.traverse((node) => {
            if (node.isMesh) {
                // Add to collidable objects array
                collidableObjects.push(node);
                
                // Fix material transparency and side issues
                if (node.material) {
                    // If material is an array, process each material
                    if (Array.isArray(node.material)) {
                        node.material.forEach(mat => {
                            mat.transparent = false;
                            mat.opacity = 1.0;
                            mat.side = THREE.DoubleSide; // Render both sides of the geometry
                            mat.depthWrite = true;      // Ensure proper depth sorting
                            mat.needsUpdate = true;     // Update the material
                        });
                    } else {
                        // Single material
                        node.material.transparent = false;
                        node.material.opacity = 1.0;
                        node.material.side = THREE.DoubleSide;
                        node.material.depthWrite = true;
                        node.material.needsUpdate = true;
                    }
                }
                
                // Ensure normals are properly set for lighting
                if (node.geometry) {
                    node.geometry.computeVertexNormals();
                }
                
                // Optionally add a bounding box helper for debugging
                // const boxHelper = new THREE.BoxHelper(node, 0xff0000);
                // scene.add(boxHelper);
            }
        });
        
        console.log(`Added ${collidableObjects.length} collidable objects`);
        
        // Hide loading overlay
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    },
);

// Function to check for collisions with separate X and Z axis testing
function checkCollisions(nextPosition) {
    if (!character) return { collisionX: false, collisionZ: false };
    
    // Create bounding box for the character
    const characterBox = new THREE.Box3().setFromObject(character);
    
    // Modify the bounding box to only use the upper portion
    // This will make the collision detection more natural, allowing the character to step over small obstacles
    const originalHeight = characterBox.max.y - characterBox.min.y;
    const collisionHeight = originalHeight * 0.7; // Use only the top 70% of the model for collision
    
    // Adjust the minimum Y height of the bounding box
    // Add a small gap between the character's feet and the collision box to prevent floor clipping
    const footGap = 0.1; // Small gap between feet and collision box
    characterBox.min.y = characterBox.max.y - collisionHeight + footGap;
    
    // Create two separate boxes for testing X and Z collisions independently
    const xBox = characterBox.clone();
    xBox.min.x = nextPosition.x - (character.position.x - characterBox.min.x);
    xBox.max.x = nextPosition.x + (characterBox.max.x - character.position.x);
    
    const zBox = characterBox.clone();
    zBox.min.z = nextPosition.z - (character.position.z - characterBox.min.z);
    zBox.max.z = nextPosition.z + (characterBox.max.z - character.position.z);
    
    let collisionX = false;
    let collisionZ = false;
    
    // Check for collisions with all collidable objects
    for (const object of collidableObjects) {
        const objectBox = new THREE.Box3().setFromObject(object);
        
        if (xBox.intersectsBox(objectBox)) {
            collisionX = true;
        }
        
        if (zBox.intersectsBox(objectBox)) {
            collisionZ = true;
        }
        
        // Early exit if we've detected collisions on both axes
        if (collisionX && collisionZ) break;
    }
    
    // Debug visualization for collision boxes (uncomment for debugging)
    // visualizeCollisionBoxes(characterBox, xBox, zBox);
    
    return { collisionX, collisionZ };
}

// Optional: Function to visualize collision boxes for debugging
function visualizeCollisionBoxes(characterBox, xBox, zBox) {
    // Remove old helpers if they exist
    if (window.boxHelpers) {
        window.boxHelpers.forEach(helper => {
            scene.remove(helper);
        });
    }
    
    // Create new box helpers
    const helpers = [];
    const characterBoxHelper = new THREE.Box3Helper(characterBox, 0xff0000);
    const xBoxHelper = new THREE.Box3Helper(xBox, 0x00ff00);
    const zBoxHelper = new THREE.Box3Helper(zBox, 0x0000ff);
    
    helpers.push(characterBoxHelper, xBoxHelper, zBoxHelper);
    helpers.forEach(helper => scene.add(helper));
    
    // Store for later removal
    window.boxHelpers = helpers;
}

// Update the updateCharacterMovement function to use collision detection
const originalUpdateCharacterMovement = updateCharacterMovement;
updateCharacterMovement = function() {
    if (!character) return;
    
    characterState.isRunning = keys.shift && keys.w;
    
    // Reset movement direction
    characterState.direction.set(0, 0, 0);
    
    // Calculate movement direction based on keys - now relative to camera
    if (keys.w) characterState.direction.add(characterState.cameraForward);
    if (keys.s) characterState.direction.add(characterState.cameraForward.clone().negate());
    if (keys.a) characterState.direction.add(characterState.cameraRight.clone().negate());
    if (keys.d) characterState.direction.add(characterState.cameraRight);
    
    // Normalize if moving diagonally
    if (characterState.direction.length() > 0) {
        characterState.direction.normalize();
        
        // Rotate character to face movement direction
        const targetRotation = Math.atan2(characterState.direction.x, characterState.direction.z);
        
        // Apply additional -Math.PI/2 rotation offset to make the animation face the right direction
        const rotationOffset = Math.PI / 2;
        
        // Smoothly rotate to target rotation (important for GTA-like feel)
        const currentRotation = character.rotation.y;
        const rotationDiff = (targetRotation + rotationOffset) - currentRotation;
        
        // Handle angle wrap-around
        let angleDiff = ((rotationDiff + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        
        // Apply smooth rotation (adjust 0.15 for faster/slower turns)
        character.rotation.y += angleDiff * 0.15;
        
        // Set moving flag
        characterState.isMoving = true;
    } else {
        characterState.isMoving = false;
    }
    
    // Calculate movement speed
    const speed = characterState.isRunning ? characterState.runSpeed : characterState.speed;
    
    // Update position with collision detection
    if (characterState.isMoving) {
        // Calculate next position
        const nextPosition = character.position.clone();
        nextPosition.x += characterState.direction.x * speed;
        nextPosition.z += characterState.direction.z * speed;
        
        // Check for collisions
        const { collisionX, collisionZ } = checkCollisions(nextPosition);
        
        // Update position, allowing sliding along walls by moving on non-colliding axes
        if (!collisionX) {
            character.position.x = nextPosition.x;
        }
        if (!collisionZ) {
            character.position.z = nextPosition.z;
        }
        
        // Debug info
        debugElement.innerText = `Moving: ${characterState.direction.x.toFixed(2)},${characterState.direction.z.toFixed(2)} | Rotation: ${(character.rotation.y * (180/Math.PI)).toFixed(0)}°`;
        if (collisionX || collisionZ) {
            debugElement.innerText += " | Collision detected";
        }
    }
    
    // Handle jumping
    if (keys.space && !characterState.isJumping) {
        characterState.velocity.y = characterState.jumpHeight;
        characterState.isJumping = true;
        playAnimation('jumping');
    }
    
    // Apply gravity
    characterState.velocity.y -= characterState.gravity;
    character.position.y += characterState.velocity.y;
    
    // Check ground collision - adjusted to account for city floor height
    const groundLevel = 0.05; // Same as the city's Y position
    if (character.position.y <= groundLevel) {
        character.position.y = groundLevel;
        characterState.velocity.y = 0;
        characterState.isJumping = false;
    }
    
    // Update animations based on movement state
    if (!characterState.isJumping) {
        if (characterState.isMoving) {
            if (characterState.isRunning) {
                playAnimation('running');
            } else {
                playAnimation('walking');
            }
        } else {
            playAnimation('idle');
        }
    }
};




// Character and animation setup
let character;
let mixer;
let animations = {};
let currentAction = null;
let prevAction = null;

// Load the GLB model
function loadCharacterModel() {
    const loader = new GLTFLoader(loadingManager);
    loader.load(
        '../models/idkbro.glb',
        (gltf) => {
            console.log("GLB model loaded successfully:", gltf);
            
            character = gltf.scene;
            character.scale.set(1.5, 1.5, 1.5);
            character.position.y = 0;
            // Initial orientation for the character model
            character.rotation.z = Math.PI / 2;
            character.rotation.y = -Math.PI / 2;
            
            // Apply shadows to all meshes
            character.traverse((node) => {
                if (node.isMesh && node.material) {
                    // For a single color
                    node.material.color.setHex(0x1B69FA); // Red color
                    
                    // Or for different materials based on name
                    if (node.name.includes('Body')) {
                        node.material.color.setHex(0x1B69FA); // Red for body
                    } else if (node.name.includes('Head')) {
                        node.material.color.setHex(0x1B69FA); // Yellow for head
                    }
                    node.material.metalness = 0;  // Lower metalness for less reflection
                    node.material.roughness = 1;  // Higher roughness for more light scattering
                }
            });
            
            scene.add(character);
            
            // Setup animation mixer
            mixer = new THREE.AnimationMixer(character);
            
            // Log available animations for debugging
            console.log("Available animations:", gltf.animations.map(a => a.name));
            
            // Store all animations with the correct mappings
            gltf.animations.forEach((clip) => {
                const action = mixer.clipAction(clip);
                
                // Using exact animation names from the model
                switch (clip.name) {
                    case "Armature.001|mixamo.com|Layer0":
                        animations.running = action;
                        console.log("Found running animation");
                        break;
                    case "Armature.001|mixamo.com|Layer0.001":
                    case "Armatur.001|mixamo.com|Layer0.001": // Both spellings for compatibility
                        animations.walking = action;
                        console.log("Found walking animation");
                        break;
                    case "Idle":
                        animations.idle = action;
                        console.log("Found idle animation");
                        break;
                    case "Jumping":
                        animations.jumping = action;
                        console.log("Found jumping animation");
                        break;
                    default:
                        console.log("Unrecognized animation:", clip.name);
                        break;
                }
            });
            
            // Check if we found all the necessary animations
            const requiredAnimations = ['idle', 'walking', 'running', 'jumping'];
            const missingAnimations = requiredAnimations.filter(name => !animations[name]);
            
            if (missingAnimations.length > 0) {
                console.warn(`Missing animations: ${missingAnimations.join(', ')}`);
                createFallbackAnimations();
            } else {
                console.log("All required animations found");
                // Start with idle animation
                playAnimation('idle');
            }
            
            // Setup GTA-like camera controls
            setupGTAControls();
            
            // Hide loading overlay
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
            }
        },
        (xhr) => {
            // Progress callback
            const percent = (xhr.loaded / xhr.total) * 100;
            console.log(`${Math.round(percent)}% loaded`);
            
            const loadingText = document.getElementById('loading-text');
            if (loadingText) {
                loadingText.innerText = `Loading model: ${Math.round(percent)}%`;
            }
        },
        (error) => {
            // Error callback
            console.error('Error loading model:', error);
            debugElement.innerText = `Error: ${error.message}`;
            
            // Fall back to simple character if model fails to load
            createSimpleCharacter();
        }
    );
}

// Create a fallback animation if the model's animations aren't available
function createFallbackAnimations() {
    console.log("Creating fallback animations");
    
    // Check which animations we're missing and create fallbacks
    if (!animations.idle) {
        animations.idle = createSimpleAnimation('idle', 0.1);
        console.log("Created fallback idle animation");
    }
    if (!animations.walking) {
        animations.walking = createSimpleAnimation('walking', 0.15);
        console.log("Created fallback walking animation");
    }
    if (!animations.running) {
        animations.running = createSimpleAnimation('running', 0.25);
        console.log("Created fallback running animation");
    }
    if (!animations.jumping) {
        animations.jumping = createSimpleAnimation('jumping', 0.5);
        console.log("Created fallback jumping animation");
    }
    
    // Start with idle animation
    playAnimation('idle');
}

// Create a simple character with basic shapes
function createSimpleCharacter() {
    // Create a simple character using basic shapes
    const group = new THREE.Group();
    
    // Body
    const bodyGeometry = new THREE.CylinderGeometry(0.5, 0.5, 2, 8);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x3333ff });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 1;
    body.castShadow = true;
    group.add(body);
    
    // Head
    const headGeometry = new THREE.SphereGeometry(0.6, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc99 });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 2.3;
    head.castShadow = true;
    group.add(head);
    
    // Arms
    const armMaterial = new THREE.MeshStandardMaterial({ color: 0x3333cc });
    
    // Left arm
    const leftArmGeometry = new THREE.CylinderGeometry(0.2, 0.2, 1.5, 8);
    const leftArm = new THREE.Mesh(leftArmGeometry, armMaterial);
    leftArm.position.set(-0.7, 1, 0);
    leftArm.rotation.z = Math.PI / 6;
    leftArm.castShadow = true;
    group.add(leftArm);
    
    // Right arm
    const rightArmGeometry = new THREE.CylinderGeometry(0.2, 0.2, 1.5, 8);
    const rightArm = new THREE.Mesh(rightArmGeometry, armMaterial);
    rightArm.position.set(0.7, 1, 0);
    rightArm.rotation.z = -Math.PI / 6;
    rightArm.castShadow = true;
    group.add(rightArm);
    
    // Legs
    const legMaterial = new THREE.MeshStandardMaterial({ color: 0x222266 });
    
    // Left leg
    const leftLegGeometry = new THREE.CylinderGeometry(0.2, 0.2, 1.5, 8);
    const leftLeg = new THREE.Mesh(leftLegGeometry, legMaterial);
    leftLeg.position.set(-0.3, -0.25, 0);
    leftLeg.castShadow = true;
    group.add(leftLeg);
    
    // Right leg
    const rightLegGeometry = new THREE.CylinderGeometry(0.2, 0.2, 1.5, 8);
    const rightLeg = new THREE.Mesh(rightLegGeometry, legMaterial);
    rightLeg.position.set(0.3, -0.25, 0);
    rightLeg.castShadow = true;
    group.add(rightLeg);
    
    group.position.y = 0;
    scene.add(group);
    
    character = group;
    mixer = new THREE.AnimationMixer(character);
    
    // Create simple animations for the character
    animations.idle = createSimpleAnimation('idle', 0.1);
    animations.walking = createSimpleAnimation('walking', 0.15);
    animations.running = createSimpleAnimation('running', 0.25);
    animations.jumping = createSimpleAnimation('jumping', 0.5);
    
    playAnimation('idle');
    debugElement.innerText = 'Simple character created';
    
    // Hide loading overlay
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'none';
    }

    return character;
}

// Create a simple animation for the character
function createSimpleAnimation(name, height) {
    const times = [0, 0.5, 1];
    const values = [0, height, 0];
    
    const positionKF = new THREE.KeyframeTrack(
        '.position.y',
        times,
        values
    );
    
    const clip = new THREE.AnimationClip(name, 1, [positionKF]);
    return mixer.clipAction(clip);
}

function playAnimation(name, duration = 0.5) {
    if (!animations[name]) {
        console.warn(`Animation ${name} not found. Available animations:`, Object.keys(animations));
        return;
    }
    
    prevAction = currentAction;
    currentAction = animations[name];
    
    // Don't restart the same animation
    if (prevAction === currentAction) return;
    
    console.log(`Playing animation: ${name}`);
    
    // Fade out the previous animation
    if (prevAction) {
        prevAction.fadeOut(duration);
    }
    
    // Reset and fade in the new animation
    currentAction.reset();
    currentAction.fadeIn(duration);
    currentAction.play();
}

// Character controls and movement
const characterState = {
    velocity: new THREE.Vector3(0, 0, 0),
    speed: 0.1,
    runSpeed: 0.2,
    jumpHeight: 0.3,
    gravity: 0.01,
    isJumping: false,
    isRunning: false,
    isMoving: false,
    direction: new THREE.Vector3(0, 0, 0),
    // Store the forward direction based on camera
    cameraForward: new THREE.Vector3(0, 0, -1),
    cameraRight: new THREE.Vector3(1, 0, 0)
};

// Camera control - GTA style
const cameraOffset = new THREE.Vector3(0, 5, 10);
const cameraLookOffset = new THREE.Vector3(0, 4, 0);
let defaultCameraPosition = new THREE.Vector3();
let defaultCameraLookAt = new THREE.Vector3();

// Setup GTA-like orbital camera controls
function setupGTAControls() {
    // Create orbit controls for the camera
    cameraOrbitControls = new OrbitControls(camera, renderer.domElement);
    cameraOrbitControls.enableDamping = true;
    cameraOrbitControls.dampingFactor = 0.1;
    cameraOrbitControls.rotateSpeed = 0.5;
    
    // Limit vertical rotation to avoid going underground
    cameraOrbitControls.minPolarAngle = Math.PI * 0.1; // 18 degrees minimum (looking down)
    cameraOrbitControls.maxPolarAngle = Math.PI * 0.5;  // 90 degrees maximum (horizontal)
    
    // Disable panning and zooming for GTA-like controls
    cameraOrbitControls.enablePan = false;
    cameraOrbitControls.enableZoom = true;  // Allow zoom but limit it
    cameraOrbitControls.minDistance = 5;
    cameraOrbitControls.maxDistance = 15;
    
    // Disable original orbit controls
    controls.enabled = false;
}

// Updated camera function for GTA-like behavior
function updateGTACamera() {
    if (!character) {
        console.warn("Character is not initialized yet.");
        return; // Exit the function if character is undefined
    }

    // Calculate the default position (behind character)
    const characterDirection = new THREE.Vector3(0, 0, -1).applyEuler(character.rotation);
    defaultCameraPosition = character.position.clone()
        .sub(characterDirection.clone().multiplyScalar(cameraOffset.z))
        .add(new THREE.Vector3(0, cameraOffset.y, 0));

    defaultCameraLookAt = character.position.clone().add(cameraLookOffset);

    // Update the orbit controls target to follow the character
    cameraOrbitControls.target.copy(character.position.clone().add(cameraLookOffset));

    // Update orbit controls
    cameraOrbitControls.update();

    // Update camera forward and right vectors for movement
    updateCameraDirections();
}

// Calculate camera-relative direction vectors for movement
function updateCameraDirections() {
    // Get the camera's forward direction in the xz plane
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0; // Keep movement in the xz plane
    forward.normalize();
    
    // Calculate the right vector from the forward vector
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    
    // Store these for movement calculations
    characterState.cameraForward = forward;
    characterState.cameraRight = right;
}

// Input tracking
const keys = {
    w: false,
    a: false,
    s: false,
    d: false,
    shift: false,
    space: false,
    lastPressed: Date.now()
};

// Event listeners
document.addEventListener('keydown', (e) => {
    updateKeyState(e.key.toLowerCase(), true);
    keys.lastPressed = Date.now();
    
    // Handle drawing activation
    if (e.key.toLowerCase() === 'e' && isLookingAtWall && !isDrawMode) {
        enterDrawMode();
    }
    // Handle exiting drawing with Escape
    else if (e.key === 'Escape' && isDrawMode) {
        cancelDrawing();
    }
});

document.addEventListener('keyup', (e) => {
    updateKeyState(e.key.toLowerCase(), false);
});

document.addEventListener('mousedown', () => {
    lastCameraInteractionTime = Date.now();
});

document.addEventListener('mouseup', () => {
    lastCameraInteractionTime = Date.now();
});

function updateKeyState(key, isPressed) {
    switch (key) {
        case 'w':
            keys.w = isPressed;
            break;
        case 'a':
            keys.a = isPressed;
            break;
        case 's':
            keys.s = isPressed;
            break;
        case 'd':
            keys.d = isPressed;
            break;
        case 'shift':
            keys.shift = isPressed;
            break;
        case ' ':
            if (isPressed && !characterState.isJumping) {
                keys.space = true;
            } else {
                keys.space = false;
            }
            break;
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Movement and physics - updated for camera-relative movement
function updateCharacterMovement() {
    if (!character) return;
    
    characterState.isRunning = keys.shift && keys.w;
    
    // Reset movement direction
    characterState.direction.set(0, 0, 0);
    
    // Calculate movement direction based on keys - now relative to camera
    if (keys.w) characterState.direction.add(characterState.cameraForward);
    if (keys.s) characterState.direction.add(characterState.cameraForward.clone().negate());
    if (keys.a) characterState.direction.add(characterState.cameraRight.clone().negate());
    if (keys.d) characterState.direction.add(characterState.cameraRight);
    
    // Normalize if moving diagonally
    if (characterState.direction.length() > 0) {
        characterState.direction.normalize();
        
        // Rotate character to face movement direction
        const targetRotation = Math.atan2(characterState.direction.x, characterState.direction.z);
        
        // Apply additional -Math.PI/2 rotation offset to make the animation face the right direction
        const rotationOffset = Math.PI / 2;
        
        // Smoothly rotate to target rotation (important for GTA-like feel)
        const currentRotation = character.rotation.y;
        const rotationDiff = (targetRotation + rotationOffset) - currentRotation;
        
        // Handle angle wrap-around
        let angleDiff = ((rotationDiff + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        
        // Apply smooth rotation (adjust 0.15 for faster/slower turns)
        character.rotation.y += angleDiff * 0.15;
        
        // Debug info
        debugElement.innerText = `Moving: ${characterState.direction.x.toFixed(2)},${characterState.direction.z.toFixed(2)} | Rotation: ${(character.rotation.y * (180/Math.PI)).toFixed(0)}°`;
        
        // Set moving flag
        characterState.isMoving = true;
    } else {
        characterState.isMoving = false;
    }
    
    // Calculate movement speed
    const speed = characterState.isRunning ? characterState.runSpeed : characterState.speed;
    
    // Update position
    if (characterState.isMoving) {
        character.position.x += characterState.direction.x * speed;
        character.position.z += characterState.direction.z * speed;
    }
    
    // Handle jumping
    if (keys.space && !characterState.isJumping) {
        characterState.velocity.y = characterState.jumpHeight;
        characterState.isJumping = true;
        playAnimation('jumping');
    }
    
    // Apply gravity
    characterState.velocity.y -= characterState.gravity;
    character.position.y += characterState.velocity.y;
    
    // Check ground collision
    if (character.position.y <= 0) {
        character.position.y = 0;
        characterState.velocity.y = 0;
        characterState.isJumping = false;
    }
    
    // Update animations based on movement state
    if (!characterState.isJumping) {
        if (characterState.isMoving) {
            if (characterState.isRunning) {
                playAnimation('running');
            } else {
                playAnimation('walking');
            }
        } else {
            playAnimation('idle');
        }
    }
}

// Function to check if the player is looking at a wall
function checkWallInView() {
  if (!camera || !scene || !character) return;
  
  // Use camera direction instead of character direction for wall detection
  const cameraDirection = new THREE.Vector3();
  camera.getWorldDirection(cameraDirection);
  
  // The ray should start from the character's head position
  const rayOrigin = character.position.clone();
  rayOrigin.y += 1.7; // Approximate head height
  
  // Create the raycaster using camera direction
  wallRaycaster.set(rayOrigin, cameraDirection);
  
  // Check for intersections with building walls
  const intersects = wallRaycaster.intersectObjects(collidableObjects, false);
  
  // Only consider intersections within a reasonable distance
  const maxDistance = 3;
  isLookingAtWall = false;
  
  // If we previously had a placement decal, remove it
  if (placementDecal) {
    scene.remove(placementDecal);
    placementDecal = null;
  }
  
  // Reset current wall
  currentWall = null;
  
  if (intersects.length > 0 && intersects[0].distance < maxDistance) {
    // Get the normal in world space
    const normal = intersects[0].face.normal.clone();
    const normalWorld = normal.transformDirection(intersects[0].object.matrixWorld);
    
    // If the surface is more vertical than horizontal (wall-like)
    if (Math.abs(normalWorld.y) < 0.5) {
      // Check if we're facing the wall (dot product between camera direction and wall normal)
      const dotProduct = cameraDirection.dot(normalWorld);
      
      // If we're facing the wall (dot product is negative as normals point outward)
      if (dotProduct < 0) {
        isLookingAtWall = true;
        currentWall = {
          object: intersects[0].object,
          point: intersects[0].point.clone(),
          normal: normalWorld,
          faceIndex: intersects[0].faceIndex
        };
        
        // Show drawing prompt
        drawPromptElement.style.display = 'block';
        
        // Update the 3D placement indicator
        updatePlacementIndicator();
      }
    }
  }
  
  // Hide drawing prompt if not looking at a wall
  if (!isLookingAtWall) {
    drawPromptElement.style.display = 'none';
  }
}

// Main animation loop
const originalAnimate = animate;
animate = function() {
  // Check for walls in view
  if (!isDrawMode) {
    checkWallInView();
  }
  
  // Update positions of all wall drawings
  updateDrawingsPositions();
  
  // Call the original animate function
  if (originalAnimate) {
    originalAnimate();
  } else {
    requestAnimationFrame(animate);
    
    const delta = 0.016; // Approximate for 60fps
    
    // Update animation mixer
    if (mixer) mixer.update(delta);
    
    // Update character movement
    updateCharacterMovement();
    
    // Update GTA-style camera
    updateGTACamera();
    
    renderer.render(scene, camera);
  }
};

function animate() {
    requestAnimationFrame(animate);
    
    const delta = 0.016; // Approximate for 60fps
    
    // Update animation mixer
    if (mixer) mixer.update(delta);
    
    // Update character movement
    updateCharacterMovement();
    
    // Update GTA-style camera
    updateGTACamera();
    
    renderer.render(scene, camera);
}

// Initialize and start the app
function init() {
  // Set up loading overlay text
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.innerText = 'Loading model...';
  }
  
  // Set up scene
  setupLights();
  createPlane();
  
  // Load the GLB model instead of creating a simple character
  loadCharacterModel();
  
  // Initialize the wall drawing system
  initializeWallDrawingSystem();
  
  // Initialize socket connection
  initializeSocket();
  
  // Fetch initial drawings (after a slight delay to ensure everything is loaded)
  setTimeout(() => {
    fetchInitialDrawings();
  }, 2000);
  
  // Start animation loop
  animate();
}

// Initialize the drawing system and create a crosshair
function initializeWallDrawingSystem() {
  initDrawingSystem();
  createCrosshair();
}

// Start the application
init();

// Instead of hardcoded localhost URLs, use a configurable backend URL
const BACKEND_URL = location.hostname === 'localhost' || location.hostname === '127.0.0.1' 
  ? 'http://localhost:3000' 
  : 'https://your-render-backend-url.onrender.com'; // Replace with your actual Render URL

// Initialize Socket.IO connection with connection recovery
function initializeSocket() {
  try {
    // Define reconnection parameters first before using them
    const reconnectionAttempts = 5;
    const reconnectionDelay = 1000;
    
    // Initialize socket with proper configuration
    socket = io(BACKEND_URL, {
      reconnectionAttempts: reconnectionAttempts,
      reconnectionDelay: reconnectionDelay,
      timeout: 10000,
      pingTimeout: 60000, 
      pingInterval: 25000
    });
    
    socket.on('connect', () => {
      console.log('Connected to server');
      serverConnected = true;
      if (window.updateConnectionStatus) {
        window.updateConnectionStatus(true);
      }
      
      // Re-send any pending drawings after reconnection
      if (pendingDrawings.size > 0) {
        console.log(`Resending ${pendingDrawings.size} pending drawings after reconnection`);
        pendingDrawings.forEach((drawingData, wallKey) => {
          console.log(`Resending drawing: ${wallKey}`);
          socket.emit('new-drawing', drawingData);
        });
      }
    });
    
    socket.on('disconnect', (reason) => {
      console.log('Disconnected from server:', reason);
      serverConnected = false;
      if (window.updateConnectionStatus) {
        window.updateConnectionStatus(false);
      }
      
      // If not due to an explicit disconnect, attempt to reconnect
      if (reason === 'io server disconnect') {
        // the disconnection was initiated by the server, reconnect manually
        setTimeout(() => {
          if (socket) socket.connect();
        }, reconnectionDelay);
      }
    });
    
    // Remove reference to maxReconnectionAttempts since it's not defined
    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      if (window.updateConnectionStatus) {
        window.updateConnectionStatus(false);
      }
      
      // We'll just log the error for now instead of tracking reconnection attempts
      console.log(`Reconnection will be attempted automatically by socket.io`);
    });
    
    // Fix other event handlers that reference socket
    socket.on('drawing-update', (drawing) => {
      if (!drawings.has(drawing.wallKey)) {
        console.log('Received new drawing from server:', drawing.wallKey);
        applyDrawingFromServer(drawing);
      }
    });
    
    socket.on('drawing-batch', (batchDrawings) => {
      console.log(`Received batch of ${batchDrawings.length} drawings`);
      batchDrawings.forEach(drawing => {
        if (!drawings.has(drawing.wallKey)) {
          applyDrawingFromServer(drawing);
        }
      });
    });
    
    socket.on('drawings-complete', () => {
      console.log('All initial drawings received');
    });
    
    socket.on('drawing-received', (response) => {
      console.log(`Server confirmed receipt of drawing: ${response.wallKey}`);
      pendingDrawings.delete(response.wallKey);
    });
    
    socket.on('drawing-error', (response) => {
      console.error(`Error with drawing ${response.wallKey}: ${response.error}`);
    });
    
    // IO specific events should use the socket.io property
    socket.io.on('reconnect_attempt', (attemptNumber) => {
      console.log(`Reconnection attempt ${attemptNumber}`);
    });
    
    socket.io.on('reconnect', () => {
      console.log('Reconnected to server');
    });
    
    socket.io.on('reconnect_failed', () => {
      console.error('Failed to reconnect to server');
      if (window.updateConnectionStatus) {
        window.updateConnectionStatus(false);
      }
    });
    
  } catch (error) {
    console.error('Failed to initialize socket:', error);
    if (window.updateConnectionStatus) {
      window.updateConnectionStatus(false);
    }
  }
}

// Apply a drawing from the server to a wall
function applyDrawingFromServer(drawing) {
  try {
    // Make sure we don't reapply our own drawings
    if (drawings.has(drawing.wallKey)) {
      console.log(`Drawing ${drawing.wallKey} already exists, skipping`);
      return;
    }
    
    console.log(`Processing drawing ${drawing.wallKey}`, drawing);
    
    // Better detection of compressed/truncated data URLs:
    // 1. Check if isCompressed flag is set
    // 2. Check if dataURL is truncated (contains "compressed" or is too short)
    if (drawing.isCompressed || 
        (drawing.dataURL && 
         (drawing.dataURL.includes("[compressed") || 
          drawing.dataURL.length < 300))) {
      
      console.log(`Drawing ${drawing.wallKey} is compressed or truncated, fetching full version...`);
      
      // Apply a placeholder first while we wait for the full version
      placeholderDrawing(drawing);
      
      // Then fetch the full-resolution version
      fetch(`${BACKEND_URL}/api/drawings/${drawing.wallKey}/full`)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
          }
          return response.json();
        })
        .then(fullDrawing => {
          if (fullDrawing && fullDrawing.dataURL && fullDrawing.dataURL.startsWith('data:image/')) {
            console.log(`Received full version of drawing ${fullDrawing.wallKey}`);
            applyFullDrawing(fullDrawing);
          } else {
            console.error(`Invalid full image data for ${drawing.wallKey}`);
          }
        })
        .catch(error => {
          console.error(`Error fetching full drawing for ${drawing.wallKey}:`, error);
          // Keep the placeholder visible to show something
        });
      
      return;
    }
    
    // Regular application for non-compressed drawings
    applyFullDrawing(drawing);
  } catch (error) {
    console.error("Error applying drawing from server:", error);
  }
}

// Apply a placeholder for a drawing while waiting for full quality
function placeholderDrawing(drawing) {
  // Create a better placeholder - standard size with clear visual indicators
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  
  // Create a more obvious placeholder that won't fail to load


  const placeholderURL = canvas.toDataURL('image/png');
  
  // Apply the placeholder
  const position = new THREE.Vector3(
    drawing.position.x,
    drawing.position.y,
    drawing.position.z
  );
  
  const normal = new THREE.Vector3(
    drawing.normal.x,
    drawing.normal.y,
    drawing.normal.z
  );
  
  console.log('Applying placeholder for drawing with position:', position, 'normal:', normal);
  findWallAndApplyDrawing(drawing.wallKey, position, normal, placeholderURL);
}

// Apply the full drawing after it's loaded
function applyFullDrawing(drawing) {
  console.log(`Applying server drawing: ${drawing.wallKey}`, drawing);
  
  if (!drawing.dataURL || !drawing.dataURL.startsWith('data:image')) {
    console.error(`Invalid dataURL for drawing ${drawing.wallKey}`);
    return;
  }
  
  // Create vectors from the position data
  const position = new THREE.Vector3(
    drawing.position.x,
    drawing.position.y,
    drawing.position.z
  );
  
  const normal = new THREE.Vector3(
    drawing.normal.x,
    drawing.normal.y,
    drawing.normal.z
  );
  
  console.log('Applying full drawing with position:', position, 'normal:', normal);
  findWallAndApplyDrawing(drawing.wallKey, position, normal, drawing.dataURL);
}

// Find wall and apply drawing
function findWallAndApplyDrawing(wallKey, position, normal, dataURL) {
  console.log(`Finding wall for drawing ${wallKey}`, { position, normal });
  console.log(`Available collidable objects: ${collidableObjects.length}`);
  
  // Find the wall this drawing belongs to
  let wallObject = null;
  
  // First try to find the wall by ID if possible
  const objectId = parseInt(wallKey.split('_')[1], 10);
  console.log(`Looking for wall with ID: ${objectId}`);
  
  if (!isNaN(objectId)) {
    for (const object of collidableObjects) {
      if (object.id === objectId) {
        wallObject = object;
        console.log(`Found wall by ID: ${objectId}`);
        break;
      }
    }
  }
  
  // Fallback to finding the closest wall
  if (!wallObject) {
    console.log('No wall found by ID, finding by distance...');
    let closestDistance = Infinity;
    let closestObject = null;
    
    for (const object of collidableObjects) {
      if (object.isMesh) {
        const objectPos = new THREE.Vector3();
        object.getWorldPosition(objectPos);
        const distance = position.distanceTo(objectPos);
        
        console.log(`Wall object ${object.id}: distance = ${distance}`);
        
        if (distance < closestDistance) {
          closestDistance = distance;
          closestObject = object;
        }
      }
    }
    
    if (closestObject) {
      wallObject = closestObject;
      console.log(`Found closest wall: ${wallObject.id} at distance ${closestDistance}`);
    }
  }
  
  // If we still don't have a wall object, use the first one
  if (!wallObject && collidableObjects.length > 0) {
    wallObject = collidableObjects[0]; // Fallback
    console.log(`Using fallback wall: ${wallObject.id}`);
  }
  
  if (!wallObject) {
    console.error("No wall objects available for drawing placement");
    // Show a visible error message in UI for debugging
    showNotification("Error: No walls found for drawing", "error");
    return;
  }
  
  // Create a fake wall object with the necessary properties
  const fakeWall = {
    object: wallObject,
    point: position,
    normal: normal,
    faceIndex: parseInt(wallKey.split('_')[2], 10) || 0
  };
  
  // Apply the drawing
  applyDrawingToWall(fakeWall, dataURL);
}

// Modified fetchInitialDrawings to handle batched drawings
async function fetchInitialDrawings() {
  try {
    console.log("Fetching drawings from server...");
    showNotification("Connecting to server...", "info");
    
    const response = await fetch(`${BACKEND_URL}/api/drawings`);
    
    if (response.ok) {
      const serverDrawings = await response.json();
      console.log(`Fetched ${serverDrawings.length} drawings from server`);
      
      if (serverDrawings.length > 0) {
        window.updateConnectionStatus(true);
        showNotification(`Loading ${serverDrawings.length} drawings...`, "info");
        
        // Dump the first drawing for debugging
        if (serverDrawings[0]) {
          console.log("Sample drawing:", JSON.stringify(serverDrawings[0]).substring(0, 200) + "...");
        }
      } else {
        showNotification("No drawings found on server", "info");
      }
      
      // Process each drawing with a delay to avoid rendering issues
      // Use a larger batch delay to prevent browser hangs
      const processBatch = (startIndex, endIndex) => {
        console.log(`Processing batch ${startIndex} to ${endIndex}`);
        for (let i = startIndex; i < endIndex && i < serverDrawings.length; i++) {
          const drawing = serverDrawings[i];
          if (!drawings.has(drawing.wallKey)) {
            setTimeout(() => {
              console.log(`Processing drawing ${i+1}/${serverDrawings.length}: ${drawing.wallKey}`);
              applyDrawingFromServer(drawing);
            }, (i - startIndex) * 50); // Stagger within the batch
          } else {
            console.log(`Drawing ${drawing.wallKey} already exists, skipping`);
          }
        }
        
        // Process the next batch if there are more drawings
        if (endIndex < serverDrawings.length) {
          setTimeout(() => {
            processBatch(endIndex, endIndex + 5);
          }, 500); // Longer delay between batches
        } else {
          showNotification(`Finished loading ${serverDrawings.length} drawings`, "success");
        }
      };
      
      // Start processing the first batch
      if (serverDrawings.length > 0) {
        processBatch(0, Math.min(5, serverDrawings.length));
      }
    } else {
      console.error("Error fetching drawings:", await response.text());
      showNotification("Failed to fetch drawings from server", "error");
    }
  } catch (error) {
    console.error('Failed to fetch drawings from server:', error);
    showNotification("Connection error: " + error.message, "error");
  }
}

// Calculate adjusted position for the drawing based on the mouse position
function calculateAdjustedPosition(wall, offset) {
  // Create a raycaster to find the new position on the wall
  const raycaster = new THREE.Raycaster();
  
  // Calculate the direction from camera to the mouse position in normalized device coordinates
  const mouseX = (offset.x / window.innerWidth) * 2;
  const mouseY = -(offset.y / window.innerHeight) * 2;
  
  // Set the raycaster based on the camera and mouse position
  raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);
  
  // Find intersections with the wall object
  const intersects = raycaster.intersectObject(wall.object);
  
  // If we found an intersection with the wall, use that position
  if (intersects.length > 0) {
    return intersects[0].point;
  }
  
  // Fallback to the original wall position
  return wall.point.clone();
}

// Modify the instructions in the HTML to include the mouse positioning info
document.addEventListener('DOMContentLoaded', function() {
  const instructionsEl = document.querySelector('.instructions ul');
  if (instructionsEl) {
    const newInstruction = document.createElement('li');
    newInstruction.innerHTML = '<strong>T:</strong> Toggle mouse positioning for drawing';
    instructionsEl.appendChild(newInstruction);
    
    const mouseInfo = document.createElement('p');
    mouseInfo.textContent = 'Move your mouse over a wall to position your drawing!';
    document.querySelector('.instructions').appendChild(mouseInfo);
  }
});

// Add a notification system to give feedback to the user
function showNotification(message, type = "info") {
  // Remove any existing notifications
  const existingNotifications = document.querySelectorAll('.drawing-notification');
  existingNotifications.forEach(notification => {
    notification.remove();
  });
  
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `drawing-notification ${type}`;
  notification.style.position = 'fixed';
  notification.style.bottom = '20px';
  notification.style.left = '50%';
  notification.style.transform = 'translateX(-50%)';
  notification.style.padding = '10px 20px';
  notification.style.borderRadius = '5px';
  notification.style.zIndex = '2000';
  notification.style.fontFamily = 'Arial, sans-serif';
  notification.style.fontSize = '14px';
  notification.style.transition = 'opacity 0.5s ease';
  
  // Set notification color based on type
  switch (type) {
    case 'success':
      notification.style.backgroundColor = 'rgba(40, 167, 69, 0.9)';
      break;
    case 'warning':
      notification.style.backgroundColor = 'rgba(255, 193, 7, 0.9)';
      break;
    case 'error':
      notification.style.backgroundColor = 'rgba(220, 53, 69, 0.9)';
      break;
    default:
      notification.style.backgroundColor = 'rgba(0, 123, 255, 0.9)';
  }
  
  notification.style.color = 'white';
  notification.textContent = message;
  
  // Add to document
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 500);
  }, 3000);
}
