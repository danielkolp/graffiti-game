import * as THREE from 'three';

// Class for managing drawing textures
export class TextureManager {
  constructor() {
    this.textureCache = new Map();
  }
  
  // Create a canvas texture for a specific wall
  createCanvasTexture(wall) {
    const textureSize = 1024; // Adjust as needed for quality
    const canvas = document.createElement('canvas');
    canvas.width = textureSize;
    canvas.height = textureSize;
    
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255, 255, 255, 0)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    
    const wallKey = this.getWallKey(wall);
    this.textureCache.set(wallKey, {
      canvas,
      ctx,
      texture
    });
    
    return texture;
  }
  
  // Get or create a texture for a wall
  getWallTexture(wall) {
    const wallKey = this.getWallKey(wall);
    
    if (!this.textureCache.has(wallKey)) {
      return this.createCanvasTexture(wall);
    }
    
    return this.textureCache.get(wallKey).texture;
  }
  
  // Draw on a specific wall's texture
  drawOnWall(wall, drawingDataURL) {
    const wallKey = this.getWallKey(wall);
    
    if (!this.textureCache.has(wallKey)) {
      this.createCanvasTexture(wall);
    }
    
    const { canvas, ctx, texture } = this.textureCache.get(wallKey);
    
    // Load the drawing image
    const img = new Image();
    img.onload = () => {
      // Apply the drawing to the canvas
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      texture.needsUpdate = true;
    };
    img.src = drawingDataURL;
    
    return texture;
  }
  
  // Generate a unique key for a wall
  getWallKey(wall) {
    return `wall_${wall.object.id}_${wall.faceIndex}`;
  }
}

// Export a singleton instance
export const textureManager = new TextureManager();
