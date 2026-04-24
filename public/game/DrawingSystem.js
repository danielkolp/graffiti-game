import * as THREE from '../vendor/three/build/three.module.js';
import { Line2 } from '../vendor/three/examples/jsm/lines/Line2.js';
import { LineMaterial } from '../vendor/three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from '../vendor/three/examples/jsm/lines/LineGeometry.js';
import { clamp } from '../utils/math.js';
import { minDistanceToPolyline, resamplePoints, simplifyStrokeRDP } from '../utils/rdp.js';

export class DrawingSystem {
  constructor(scene, camera, rendererSystem, uiManager) {
    this.scene = scene;
    this.camera = camera;
    this.rendererSystem = rendererSystem;
    this.uiManager = uiManager;

    this.collidableMeshes = [];
    this.raycaster = new THREE.Raycaster();
    this.pointerNdc = new THREE.Vector2(0, 0);
    this.centerNdc = new THREE.Vector2(0, 0);

    this.tempNormal = new THREE.Vector3();
    this.tempTangent = new THREE.Vector3();
    this.tempBitangent = new THREE.Vector3();
    this.tempCenter = new THREE.Vector3();
    this.tempPlane = new THREE.Plane();
    this.tempIntersectPoint = new THREE.Vector3();
    this.tempWorldPoint = new THREE.Vector3();
    this.tempVec = new THREE.Vector3();
    this.tempBasisMatrix = new THREE.Matrix4();
    this.probeRaycaster = new THREE.Raycaster();
    this.tempProbeOrigin = new THREE.Vector3();
    this.tempProbeDirection = new THREE.Vector3();
    this.tempProbeNormal = new THREE.Vector3();
    this.worldUp = new THREE.Vector3(0, 1, 0);
    this.altUp = new THREE.Vector3(1, 0, 0);

    this.patchSize = 4;
    this.patchHalfSize = this.patchSize * 0.5;
    this.minDrawablePatchHalfWidth = 0.55;
    this.minDrawablePatchHalfHeight = 0.55;
    this.minDrawablePatchArea = 1.2;
    this.maxDrawableNormalY = 0.45;
    this.surfaceOffset = 0.06;
    this.drawPromptMaxDistance = 11.5;

    this.quantization = 1000;
    this.maxPointsPerStroke = 280;
    this.minDistanceBetweenPoints = 0.03;
    this.simplificationEpsilon = 0.02;
    this.maxLiveStrokesPerPatch = 48;
    this.bakeBatchSize = 5;
this.bakedTextureSize = 2048;
this.textureBrushScale = 0.015;
this.activePreviewStrokeVisible = false;
    this.drawMode = false;
    this.pointerDown = false;
    this.activePointerId = null;
    this.currentCandidate = null;
    this.activePatch = null;
    this.activeStroke = [];
    this.activePreviewPoint = null;
    this.lastPaintPoint = null;
    this.activeStrokeRenderable = null;
    this.activeStrokePatchKey = null;
    this.playerObject = null;
    this.playerDrawOriginOffset = new THREE.Vector3(0, 1.2, 0);
    this.tempPlayerOrigin = new THREE.Vector3();

    this.wallScanAccumulator = 0;
    this.wallScanIntervalSeconds = 0.08;
    this.lastScanCameraPos = new THREE.Vector3();
    this.lastScanCameraQuat = new THREE.Quaternion();
    this.lastScanHadState = false;
    this.pointerDirtySinceScan = false;
    this.cameraMoveThresholdSq = 0.0025;
    this.cameraAngleThreshold = 0.01;

    this.lastPointerMoveProcessMs = 0;
    this.pointerMoveMinIntervalMs = 8;
    this.drawBoundaryDashOffset = 0;
    this.drawBoundaryDashSpeed = 1.3;

    this.activeStrokePositionsBuffer = null;

    this.patches = new Map();
    this.strokeIndex = new Map();
    this.seenStrokeIds = new Set();
    this.lineMaterials = new Set();
    this.undoStack = [];
this.redoStack = [];
    this.sendStrokeCallback = () => {};
    this.strokeCounter = 0;
    this.strokeRenderOrderCounter = 20;
    this.hasPointer = false;

    this.previewMesh = this._createPreviewMesh();
    this.scene.add(this.previewMesh);

    this.drawBoundaryMesh = this._createDrawBoundaryMesh();
    this.scene.add(this.drawBoundaryMesh);

    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    this.rendererSystem.onResize((width, height) => {
      this.viewportWidth = width;
      this.viewportHeight = height;
      for (const material of this.lineMaterials) {
        material.resolution.set(width, height);
      }
    });

    this._bindInput();
  }

  setCollidableMeshes(meshes) {
    this.collidableMeshes = meshes || [];
  }

  setPlayerObject(playerObject) {
    this.playerObject = playerObject || null;
  }

  setStrokeSendCallback(callback) {
    this.sendStrokeCallback = callback || (() => {});
  }

  isDrawModeActive() {
    return this.drawMode;
  }
_doAction(action) {
  this._applyAction(action);
  this.undoStack.push(action);
  this.redoStack.length = 0;
}

undo() {
  const targetPatchKey = this.activePatch?.key;

  if (!targetPatchKey) return false;

  for (let i = this.undoStack.length - 1; i >= 0; i -= 1) {
    const action = this.undoStack[i];

    if (action.patchKey !== targetPatchKey) {
      continue;
    }

    this.undoStack.splice(i, 1);
    this._reverseAction(action);
    this.redoStack.push(action);
    return true;
  }

  return false;
}

redo() {
  const targetPatchKey = this.activePatch?.key;

  if (!targetPatchKey) return false;

  for (let i = this.redoStack.length - 1; i >= 0; i -= 1) {
    const action = this.redoStack[i];

    if (action.patchKey !== targetPatchKey) {
      continue;
    }

    this.redoStack.splice(i, 1);
    this._applyAction(action);
    this.undoStack.push(action);
    return true;
  }

  return false;
}

_applyAction(action) {
  switch (action.type) {
   case 'add-stroke': {
  const patch = this.patches.get(action.patchKey);
  if (!patch) return;

  patch.strokeArchive.set(action.stroke.id, action.stroke);
  this.strokeIndex.set(action.stroke.id, { patchKey: patch.key, stroke: action.stroke });

  this._ensureBakedLayer(patch);
  this._rebuildBakedLayer(patch);

  break;
}

    case 'erase': {
      const patch = this.patches.get(action.patchKey);
      if (!patch) return;

      for (const snapshot of action.strokes) {
        this._removeStrokeFromPatch(patch, snapshot.id);
      }
      break;
    }
  }
}

_reverseAction(action) {
  switch (action.type) {
    case 'add-stroke': {
      const patch = this.patches.get(action.patchKey);
      if (!patch) return;

      this._removeStrokeFromPatch(patch, action.stroke.id);
      break;
    }

    case 'erase': {
      for (const snapshot of action.strokes) {
        const patch = this._getOrCreatePatchFromPacket(snapshot.patchKey, snapshot.patch);

        const restored = {
          id: snapshot.id,
          color: snapshot.color,
          thickness: snapshot.thickness,
          points: snapshot.points,
          createdAt: snapshot.createdAt,
          renderOrder: snapshot.renderOrder || this._nextStrokeRenderOrder()
        };

       if (!patch.strokeArchive.has(restored.id)) {
  patch.strokeArchive.set(restored.id, restored);
  this.strokeIndex.set(restored.id, { patchKey: patch.key, stroke: restored });
this._ensureBakedLayer(patch);
this._rebuildBakedLayer(patch);
}
      }
      break;
    }
  }
}
  update(deltaSeconds) {
    if (this.drawBoundaryMesh.visible) {
      this.drawBoundaryDashOffset += deltaSeconds * this.drawBoundaryDashSpeed;
      const dashShader = this.drawBoundaryMesh.material?.userData?.dashShader;
      if (dashShader?.uniforms?.dashOffset) {
        dashShader.uniforms.dashOffset.value = this.drawBoundaryDashOffset;
      }
    }

    if (this.drawMode) {
      this.uiManager.setDrawPrompt(true, 'Drawing mode - hold mouse to paint, Esc to exit');
      return;
    }

    this.wallScanAccumulator += deltaSeconds;
    if (this.wallScanAccumulator < this.wallScanIntervalSeconds) {
      return;
    }

    if (!this._shouldRunWallScan()) {
      return;
    }

    this.wallScanAccumulator = 0;

    // Prefer cursor hover targeting; use center-screen targeting only as a fallback.
    const hit = this._findWallAtPointer() || this._findWallInFront();
    this._markScanState();
    if (!hit) {
      this.currentCandidate = null;
      this.previewMesh.visible = false;
      if (!this.drawMode) {
        this.drawBoundaryMesh.visible = false;
      }
      this.uiManager.setDrawPrompt(false);
      return;
    }

    const descriptor = this._buildPatchDescriptor(hit);
    if (!this._isDrawablePatchDescriptor(descriptor)) {
      this.currentCandidate = null;
      this.previewMesh.visible = false;
      this.drawBoundaryMesh.visible = false;
      this.uiManager.setDrawPrompt(false);
      return;
    }

    this.currentCandidate = descriptor;
    this._updatePreviewMesh(descriptor);
    this._updateDrawBoundaryMesh(descriptor);
    this.uiManager.setDrawPrompt(true, 'Wall in front - press E to paint');
  }

  applyInitialStrokes(strokes) {
    for (const stroke of strokes) {
      this.applyStrokePacket(stroke);
    }
  }

  applyStrokePacket(packet) {
    if (!packet || !packet.id || this.seenStrokeIds.has(packet.id)) {
      return;
    }

    if (packet.erase === true) {
      this.seenStrokeIds.add(packet.id);
      this._applyErasePacket(packet);
      return;
    }

    if (!packet.patch || !Array.isArray(packet.points)) {
      return;
    }

    const patch = this._getOrCreatePatchFromPacket(packet.patchKey, packet.patch);
    const points = this._decodePoints(packet.points, packet.q || this.quantization);

    if (points.length < 2) {
      return;
    }

    const stroke = {
      id: packet.id,
      color: packet.color || '#ff3d3d',
      thickness: clamp(Number(packet.thickness) || 6, 1, 24),
      points,
      createdAt: packet.createdAt || Date.now(),
      playerId: packet.playerId || null,
      renderOrder: this._nextStrokeRenderOrder()
    };


    this._insertStroke(patch, stroke, false);
    this.seenStrokeIds.add(stroke.id);
  }

  _bindInput() {
    window.addEventListener('keydown', (event) => {
      const key = event.key.toLowerCase();

      if (key === 'e' && !this.drawMode && this.currentCandidate) {
        this._enterDrawMode();
      }

      if (event.key === 'Escape' && this.drawMode) {
        this._exitDrawMode();
      }
     
    });
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) {
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? this.redo() : this.undo();
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    this.redo();
  }
});
    const domElement = this.rendererSystem.getDomElement();

    domElement.addEventListener('pointerdown', (event) => {
      if (!this.drawMode) {
        return;
      }

      this._updatePointerNdc(event);
      const localPoint = this._sampleLocalPointOnActivePatch();
      if (!localPoint) {
        return;
      }

      this.pointerDown = true;
      this.activePointerId = event.pointerId;
      if (typeof domElement.setPointerCapture === 'function') {
        domElement.setPointerCapture(event.pointerId);
      }

      if (this.uiManager.getTool() === 'erase') {
        this._clearActiveStrokeRenderable();
        this._eraseAtPoint(localPoint);
        return;
      }

      this.activeStroke = [localPoint];
      this.lastPaintPoint = localPoint;
      this.activePreviewPoint = this._createInitialPreviewPoint(localPoint);
      this._updateActiveStrokeRenderable();
    });

    domElement.addEventListener('pointermove', (event) => {
      this._updatePointerNdc(event);

      if (!this.drawMode || !this.pointerDown) {
        return;
      }

      this._processPointerMoveDraw();
    });

    const finalizeStroke = () => {
      if (!this.drawMode || !this.pointerDown) {
        this.pointerDown = false;
        this.activePointerId = null;
        this._clearActiveStrokeRenderable();
        this.activePreviewPoint = null;
        return;
      }

      this.pointerDown = false;

      if (this.activePointerId !== null && typeof domElement.releasePointerCapture === 'function') {
        try {
          if (domElement.hasPointerCapture?.(this.activePointerId)) {
            domElement.releasePointerCapture(this.activePointerId);
          }
        } catch {
          // Ignore capture release errors on browsers that are strict about pointer state.
        }
      }
      this.activePointerId = null;

      if (this.uiManager.getTool() === 'erase') {
        this._clearActiveStrokeRenderable();
        this.activePreviewPoint = null;
        return;
      }

      const finalizedPoints = this.activeStroke.slice();
      if (this.activePreviewPoint) {
        const lastPoint = finalizedPoints[finalizedPoints.length - 1];
        if (!lastPoint || lastPoint.x !== this.activePreviewPoint.x || lastPoint.y !== this.activePreviewPoint.y) {
          finalizedPoints.push(this.activePreviewPoint);
        }
      }

      if (finalizedPoints.length < 2 || !this.activePatch) {
        this.activeStroke = [];
        this.lastPaintPoint = null;
        this.activePreviewPoint = null;
        this._clearActiveStrokeRenderable();
        return;
      }

      const simplified = simplifyStrokeRDP(finalizedPoints, this.simplificationEpsilon);
      const bounded = resamplePoints(simplified, this.maxPointsPerStroke);

      if (bounded.length < 2) {
        this.activeStroke = [];
        this.lastPaintPoint = null;
        this.activePreviewPoint = null;
        this._clearActiveStrokeRenderable();
        return;
      }

      const stroke = {
        id: this._nextStrokeId(),
        color: this.uiManager.getBrushColor(),
        thickness: clamp(this.uiManager.getBrushSize(), 1, 24),
        points: bounded,
        createdAt: Date.now(),
        renderOrder: this._nextStrokeRenderOrder()
      };

      this._clearActiveStrokeRenderable();
      this._insertStroke(this.activePatch, stroke, true);

      this.activeStroke = [];
      this.lastPaintPoint = null;
      this.activePreviewPoint = null;
    };

    domElement.addEventListener('pointerup', finalizeStroke);
    domElement.addEventListener('pointercancel', finalizeStroke);
    domElement.addEventListener('pointerleave', () => {
      if (this.activePointerId !== null && typeof domElement.hasPointerCapture === 'function' && domElement.hasPointerCapture(this.activePointerId)) {
        return;
      }

      finalizeStroke();
    });
  }

  _enterDrawMode() {
    this.activePatch = this._getOrCreatePatch(this.currentCandidate);
    this.drawMode = true;
    this.pointerDown = false;
    this.activePointerId = null;
    this.activeStroke = [];
    this.lastPaintPoint = null;
    this.activePreviewPoint = null;
    this._clearActiveStrokeRenderable();
    this.previewMesh.visible = false;
    this._updateDrawBoundaryMesh(this.activePatch);
    this.uiManager.setDrawMode(true);
    this.uiManager.setDrawPrompt(true, 'Drawing mode - hold mouse to paint, Esc to exit');
  }

  _exitDrawMode() {
    this.drawMode = false;
    this.pointerDown = false;
    this.activePointerId = null;
    this.activePatch = null;
    this.activeStroke = [];
    this.lastPaintPoint = null;
    this.activePreviewPoint = null;
    this._clearActiveStrokeRenderable();
    this.previewMesh.visible = false;
    this.drawBoundaryMesh.visible = false;
    this.uiManager.setDrawMode(false);
    this.uiManager.setDrawPrompt(false);
  }

  _processPointerMoveDraw() {
    const now = performance.now();
    if ((now - this.lastPointerMoveProcessMs) < this.pointerMoveMinIntervalMs) {
      return;
    }
    this.lastPointerMoveProcessMs = now;

    const localPoint = this._sampleLocalPointOnActivePatch();
    if (!localPoint) {
      return;
    }

    if (this.uiManager.getTool() === 'erase') {
      this._clearActiveStrokeRenderable();
      this._eraseAtPoint(localPoint);
      return;
    }

    this.activePreviewPoint = localPoint;
    this._updateActiveStrokeRenderable();

    if (!this.lastPaintPoint) {
      return;
    }

    const dx = localPoint.x - this.lastPaintPoint.x;
    const dy = localPoint.y - this.lastPaintPoint.y;
    if ((dx * dx) + (dy * dy) >= (this.minDistanceBetweenPoints * this.minDistanceBetweenPoints)) {
      this.activeStroke.push(localPoint);
      this.lastPaintPoint = localPoint;
      this.activePreviewPoint = localPoint;
      this._updateActiveStrokeRenderable();
    }
  }

  _shouldRunWallScan() {
    if (!this.lastScanHadState) {
      return true;
    }

    const movedEnough = this.camera.position.distanceToSquared(this.lastScanCameraPos) > this.cameraMoveThresholdSq;
    const turnedEnough = this.camera.quaternion.angleTo(this.lastScanCameraQuat) > this.cameraAngleThreshold;
    return movedEnough || turnedEnough || this.pointerDirtySinceScan;
  }

  _markScanState() {
    this.lastScanCameraPos.copy(this.camera.position);
    this.lastScanCameraQuat.copy(this.camera.quaternion);
    this.lastScanHadState = true;
    this.pointerDirtySinceScan = false;
  }

  _findWallAtPointer() {
    if (!this.hasPointer) {
      return null;
    }
    return this._findWallAtNdc(this.pointerNdc);
  }

  _findWallInFront() {
    return this._findWallAtNdc(this.centerNdc);
  }

  _findWallAtNdc(ndc) {
    if (!this.collidableMeshes || this.collidableMeshes.length === 0) {
      return null;
    }

    this.raycaster.setFromCamera(ndc, this.camera);

    const intersections = this.raycaster.intersectObjects(this.collidableMeshes, false);

    for (const hit of intersections) {
      if (!hit.face || !this._isWithinPlayerDrawDistance(hit.point)) {
        continue;
      }

      this.tempNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
      if (Math.abs(this.tempNormal.y) > 0.65) {
        continue;
      }

      const facing = this.raycaster.ray.direction.dot(this.tempNormal);
      if (facing > -0.1) {
        continue;
      }

      return hit;
    }

    return null;
  }

  _isWithinPlayerDrawDistance(worldPoint) {
    if (!worldPoint) {
      return false;
    }

    if (this.playerObject) {
      this.tempPlayerOrigin.copy(this.playerObject.position).add(this.playerDrawOriginOffset);
      return this.tempPlayerOrigin.distanceTo(worldPoint) <= this.drawPromptMaxDistance;
    }

    return worldPoint.distanceTo(this.camera.position) <= this.drawPromptMaxDistance;
  }

  _isDrawablePatchDescriptor(descriptor) {
    if (!descriptor) {
      return false;
    }

    const width = Number.isFinite(descriptor.maxX) && Number.isFinite(descriptor.minX)
      ? Math.max(0, descriptor.maxX - descriptor.minX)
      : Math.max(0, (descriptor.halfWidth || descriptor.halfSize || 0) * 2);
    const height = Number.isFinite(descriptor.maxY) && Number.isFinite(descriptor.minY)
      ? Math.max(0, descriptor.maxY - descriptor.minY)
      : Math.max(0, (descriptor.halfHeight || descriptor.halfSize || 0) * 2);

    if (width < (this.minDrawablePatchHalfWidth * 2) || height < (this.minDrawablePatchHalfHeight * 2)) {
      return false;
    }

    if ((width * height) < this.minDrawablePatchArea) {
      return false;
    }

    if (Math.abs(descriptor.normal?.y || 0) > this.maxDrawableNormalY) {
      return false;
    }

    return true;
  }

  _buildPatchDescriptor(hit) {
    this.tempNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();

    const up = Math.abs(this.tempNormal.y) > 0.9 ? this.altUp : this.worldUp;
    this.tempTangent.crossVectors(up, this.tempNormal).normalize();
    if (this.tempTangent.lengthSq() < 0.00001) {
      this.tempTangent.set(1, 0, 0);
    }
    this.tempBitangent.crossVectors(this.tempNormal, this.tempTangent).normalize();

    const planeDistance = this.tempNormal.dot(hit.point);
    const rawU = this.tempTangent.dot(hit.point);
    const rawV = this.tempBitangent.dot(hit.point);
    const projectionRange = this._computeMeshProjectionRange(hit.object, this.tempTangent, this.tempBitangent);

    const spanU = Math.max(0.01, projectionRange.maxU - projectionRange.minU);
    const spanV = Math.max(0.01, projectionRange.maxV - projectionRange.minV);
    const cellsU = Math.max(1, Math.ceil(spanU / this.patchSize));
    const cellsV = Math.max(1, Math.ceil(spanV / this.patchSize));

    const cellU = clamp(Math.floor((rawU - projectionRange.minU) / this.patchSize), 0, cellsU - 1);
    const cellV = clamp(Math.floor((rawV - projectionRange.minV) / this.patchSize), 0, cellsV - 1);

    const cellStartU = projectionRange.minU + (cellU * this.patchSize);
    const cellEndU = Math.min(projectionRange.maxU, cellStartU + this.patchSize);
    const cellStartV = projectionRange.minV + (cellV * this.patchSize);
    const cellEndV = Math.min(projectionRange.maxV, cellStartV + this.patchSize);

    const centerU = (cellStartU + cellEndU) * 0.5;
    const centerV = (cellStartV + cellEndV) * 0.5;

    this.tempCenter
      .copy(this.tempTangent).multiplyScalar(centerU)
      .addScaledVector(this.tempBitangent, centerV)
      .addScaledVector(this.tempNormal, planeDistance);

    const probeOffset = Math.max(this.surfaceOffset * 2.2, 0.05);
    if (!this._isPointOnMeshSurface(hit.object, this.tempCenter, probeOffset)) {
      return null;
    }

    const key = `${hit.object.id}:${cellU}:${cellV}`;
    const cached = this.patches.get(key);
    if (cached) {
      return {
        key,
        meshId: cached.meshId,
        center: cached.center.clone(),
        normal: cached.normal.clone(),
        tangent: cached.tangent.clone(),
        bitangent: cached.bitangent.clone(),
        minX: Number.isFinite(cached.minX) ? cached.minX : -(cached.halfWidth || cached.halfSize || this.patchHalfSize),
        maxX: Number.isFinite(cached.maxX) ? cached.maxX : (cached.halfWidth || cached.halfSize || this.patchHalfSize),
        minY: Number.isFinite(cached.minY) ? cached.minY : -(cached.halfHeight || cached.halfSize || this.patchHalfSize),
        maxY: Number.isFinite(cached.maxY) ? cached.maxY : (cached.halfHeight || cached.halfSize || this.patchHalfSize),
        halfWidth: cached.halfWidth || cached.halfSize || this.patchHalfSize,
        halfHeight: cached.halfHeight || cached.halfSize || this.patchHalfSize,
        halfSize: cached.halfSize || this.patchHalfSize
      };
    }

    const cellMinX = cellStartU - centerU;
    const cellMaxX = cellEndU - centerU;
    const cellMinY = cellStartV - centerV;
    const cellMaxY = cellEndV - centerV;
    const surfaceBounds = this._computePatchSurfaceBounds(hit, this.tempCenter);
    const adjustedMinX = Math.max(surfaceBounds.minX, cellMinX);
    const adjustedMaxX = Math.min(surfaceBounds.maxX, cellMaxX);
    const adjustedMinY = Math.max(surfaceBounds.minY, cellMinY);
    const adjustedMaxY = Math.min(surfaceBounds.maxY, cellMaxY);

    if (adjustedMaxX <= adjustedMinX || adjustedMaxY <= adjustedMinY) {
      return null;
    }

    return {
      key,
      meshId: hit.object.id,
      center: this.tempCenter.clone(),
      normal: this.tempNormal.clone(),
      tangent: this.tempTangent.clone(),
      bitangent: this.tempBitangent.clone(),
      minX: adjustedMinX,
      maxX: adjustedMaxX,
      minY: adjustedMinY,
      maxY: adjustedMaxY,
      halfWidth: (adjustedMaxX - adjustedMinX) * 0.5,
      halfHeight: (adjustedMaxY - adjustedMinY) * 0.5,
      halfSize: Math.max((adjustedMaxX - adjustedMinX) * 0.5, (adjustedMaxY - adjustedMinY) * 0.5)
    };
  }

  _computeMeshProjectionRange(mesh, tangent, bitangent) {
    if (!mesh?.geometry) {
      return {
        minU: -this.patchHalfSize,
        maxU: this.patchHalfSize,
        minV: -this.patchHalfSize,
        maxV: this.patchHalfSize
      };
    }

    const geometry = mesh.geometry;
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }

    const bounds = geometry.boundingBox;
    if (!bounds) {
      return {
        minU: -this.patchHalfSize,
        maxU: this.patchHalfSize,
        minV: -this.patchHalfSize,
        maxV: this.patchHalfSize
      };
    }

    mesh.updateWorldMatrix(true, false);

    const min = bounds.min;
    const max = bounds.max;
    const corners = [
      [min.x, min.y, min.z],
      [min.x, min.y, max.z],
      [min.x, max.y, min.z],
      [min.x, max.y, max.z],
      [max.x, min.y, min.z],
      [max.x, min.y, max.z],
      [max.x, max.y, min.z],
      [max.x, max.y, max.z]
    ];

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;

    for (const [x, y, z] of corners) {
      this.tempWorldPoint.set(x, y, z).applyMatrix4(mesh.matrixWorld);
      const u = this.tempWorldPoint.dot(tangent);
      const v = this.tempWorldPoint.dot(bitangent);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    return {
      minU,
      maxU,
      minV,
      maxV
    };
  }

  _computePatchSurfaceBounds(hit, center) {
    const mesh = hit?.object;
    if (!mesh) {
      return {
        minX: -this.patchHalfSize,
        maxX: this.patchHalfSize,
        minY: -this.patchHalfSize,
        maxY: this.patchHalfSize
      };
    }

    const boundsX = this._measureAxisBounds(mesh, center, this.tempTangent);
    const boundsY = this._measureAxisBounds(mesh, center, this.tempBitangent);

    return {
      minX: boundsX.min,
      maxX: boundsX.max,
      minY: boundsY.min,
      maxY: boundsY.max
    };
  }

  _measureAxisBounds(mesh, center, axis) {
    const maxDistance = this.patchHalfSize;
    const positive = this._probeExtent(mesh, center, axis, maxDistance);
    const negative = this._probeExtent(mesh, center, this.tempVec.copy(axis).multiplyScalar(-1), maxDistance);

    return {
      min: -Math.max(0.2, Math.min(this.patchHalfSize, negative)),
      max: Math.max(0.2, Math.min(this.patchHalfSize, positive))
    };
  }

  _probeExtent(mesh, center, direction, maxDistance) {
    let low = 0;
    let high = maxDistance;
    const probeOffset = Math.max(this.surfaceOffset * 2.2, 0.05);

    for (let i = 0; i < 7; i += 1) {
      const mid = (low + high) * 0.5;
      this.tempWorldPoint.copy(center).addScaledVector(direction, mid);
      if (this._isPointOnMeshSurface(mesh, this.tempWorldPoint, probeOffset)) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return low;
  }

  _isPointOnMeshSurface(mesh, worldPoint, probeOffset) {
    this.tempProbeOrigin.copy(worldPoint).addScaledVector(this.tempNormal, probeOffset);
    this.tempProbeDirection.copy(this.tempNormal).multiplyScalar(-1);

    this.probeRaycaster.set(this.tempProbeOrigin, this.tempProbeDirection);
    this.probeRaycaster.near = 0;
    this.probeRaycaster.far = probeOffset * 4;

    const hits = this.probeRaycaster.intersectObject(mesh, false);
    if (!hits || hits.length === 0) {
      return false;
    }

    const firstHit = hits[0];
    if (!firstHit.face) {
      return false;
    }

    if (firstHit.point.distanceTo(worldPoint) > 0.08) {
      return false;
    }

    this.tempProbeNormal.copy(firstHit.face.normal).transformDirection(mesh.matrixWorld).normalize();
    return Math.abs(this.tempProbeNormal.dot(this.tempNormal)) > 0.7;
  }

  _getOrCreatePatch(descriptor) {
    const existing = this.patches.get(descriptor.key);
    if (existing) {
      return existing;
    }

    const group = new THREE.Group();
    group.name = `Patch-${descriptor.key}`;
    this.scene.add(group);

    const patch = {
      key: descriptor.key,
      meshId: descriptor.meshId,
      center: descriptor.center.clone(),
      normal: descriptor.normal.clone(),
      tangent: descriptor.tangent.clone(),
      bitangent: descriptor.bitangent.clone(),
      halfSize: descriptor.halfSize,
      halfWidth: descriptor.halfWidth || descriptor.halfSize,
      halfHeight: descriptor.halfHeight || descriptor.halfSize,
      minX: Number.isFinite(descriptor.minX) ? descriptor.minX : -(descriptor.halfWidth || descriptor.halfSize),
      maxX: Number.isFinite(descriptor.maxX) ? descriptor.maxX : (descriptor.halfWidth || descriptor.halfSize),
      minY: Number.isFinite(descriptor.minY) ? descriptor.minY : -(descriptor.halfHeight || descriptor.halfSize),
      maxY: Number.isFinite(descriptor.maxY) ? descriptor.maxY : (descriptor.halfHeight || descriptor.halfSize),
      group,
      liveStrokes: [],
      strokeArchive: new Map(),
      bakedLayer: null
    };

    this.patches.set(patch.key, patch);
    return patch;
  }

  _getOrCreatePatchFromPacket(patchKey, packetPatch) {
    const key = patchKey || packetPatch.key;
    const existing = this.patches.get(key);
    if (existing) {
      return existing;
    }

    const descriptor = {
      key,
      meshId: packetPatch.meshId || -1,
      center: new THREE.Vector3(packetPatch.center[0], packetPatch.center[1], packetPatch.center[2]),
      normal: new THREE.Vector3(packetPatch.normal[0], packetPatch.normal[1], packetPatch.normal[2]).normalize(),
      tangent: new THREE.Vector3(packetPatch.tangent[0], packetPatch.tangent[1], packetPatch.tangent[2]).normalize(),
      bitangent: new THREE.Vector3(packetPatch.bitangent[0], packetPatch.bitangent[1], packetPatch.bitangent[2]).normalize(),
      halfSize: Number(packetPatch.halfSize) || this.patchHalfSize,
      halfWidth: Number(packetPatch.halfWidth) || Number(packetPatch.halfSize) || this.patchHalfSize,
      halfHeight: Number(packetPatch.halfHeight) || Number(packetPatch.halfSize) || this.patchHalfSize,
      minX: Number.isFinite(Number(packetPatch.minX)) ? Number(packetPatch.minX) : -(Number(packetPatch.halfWidth) || Number(packetPatch.halfSize) || this.patchHalfSize),
      maxX: Number.isFinite(Number(packetPatch.maxX)) ? Number(packetPatch.maxX) : (Number(packetPatch.halfWidth) || Number(packetPatch.halfSize) || this.patchHalfSize),
      minY: Number.isFinite(Number(packetPatch.minY)) ? Number(packetPatch.minY) : -(Number(packetPatch.halfHeight) || Number(packetPatch.halfSize) || this.patchHalfSize),
      maxY: Number.isFinite(Number(packetPatch.maxY)) ? Number(packetPatch.maxY) : (Number(packetPatch.halfHeight) || Number(packetPatch.halfSize) || this.patchHalfSize)
    };

    return this._getOrCreatePatch(descriptor);
  }

  _sampleLocalPointOnActivePatch() {
    if (!this.activePatch) {
      return null;
    }

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    this.tempPlane.setFromNormalAndCoplanarPoint(this.activePatch.normal, this.activePatch.center);
    const hit = this.raycaster.ray.intersectPlane(this.tempPlane, this.tempIntersectPoint);
    if (!hit) {
      return null;
    }

    this.tempVec.copy(this.tempIntersectPoint).sub(this.activePatch.center);

    const localX = clamp(this.tempVec.dot(this.activePatch.tangent), this.activePatch.minX, this.activePatch.maxX);
    const localY = clamp(this.tempVec.dot(this.activePatch.bitangent), this.activePatch.minY, this.activePatch.maxY);

    return { x: localX, y: localY };
  }

_insertStroke(patch, stroke, emitNetwork) {
  if (emitNetwork) {
    this._doAction({
      type: 'add-stroke',
      stroke,
      patchKey: patch.key
    });

    this.sendStrokeCallback(this._encodeStrokePacket(patch, stroke));
  } else {
    // remote strokes only
    this._applyAction({
      type: 'add-stroke',
      stroke,
      patchKey: patch.key
    });
  }
}



  _nextStrokeRenderOrder() {
    this.strokeRenderOrderCounter += 1;
    return this.strokeRenderOrderCounter;
  }

_updateActiveStrokeRenderable() {
  if (!this.activePatch || this.activeStroke.length < 1 || !this.activePreviewPoint) {
    this._clearActiveStrokeRenderable();
    return;
  }

  const previewPoints = this.activeStroke.slice();
  const lastPoint = previewPoints[previewPoints.length - 1];

  if (
    !lastPoint ||
    lastPoint.x !== this.activePreviewPoint.x ||
    lastPoint.y !== this.activePreviewPoint.y
  ) {
    previewPoints.push(this.activePreviewPoint);
  }

  const previewStroke = {
    id: '__preview__',
    color: this.uiManager.getBrushColor(),
    thickness: clamp(this.uiManager.getBrushSize(), 1, 24),
    points: previewPoints
  };

  this._ensureBakedLayer(this.activePatch);
  this._renderPatchCanvas(this.activePatch, previewStroke);
  this.activePreviewStrokeVisible = true;
}

  _createInitialPreviewPoint(localPoint) {
    const offset = Math.max(this.minDistanceBetweenPoints * 0.35, 0.01);
    const candidates = [
      { x: localPoint.x + offset, y: localPoint.y },
      { x: localPoint.x - offset, y: localPoint.y },
      { x: localPoint.x, y: localPoint.y + offset },
      { x: localPoint.x, y: localPoint.y - offset }
    ];

    for (const candidate of candidates) {
      const clamped = {
        x: clamp(candidate.x, this.activePatch.minX, this.activePatch.maxX),
        y: clamp(candidate.y, this.activePatch.minY, this.activePatch.maxY)
      };

      if (clamped.x !== localPoint.x || clamped.y !== localPoint.y) {
        return clamped;
      }
    }

    return { x: localPoint.x + offset, y: localPoint.y };
  }

_clearActiveStrokeRenderable() {
  if (this.activeStrokeRenderable) {
    const liveLine = this.activeStrokeRenderable;
    const { geometry, material } = liveLine;

    if (liveLine.parent) {
      liveLine.parent.remove(liveLine);
    }

    geometry?.dispose?.();

    if (material) {
      this.lineMaterials.delete(material);
      material.dispose?.();
    }
  }

  this.activeStrokeRenderable = null;
  this.activeStrokePatchKey = null;
  this.activeStrokePositionsBuffer = null;

  if (this.activePreviewStrokeVisible && this.activePatch?.bakedLayer) {
    this._renderPatchCanvas(this.activePatch);
  }

  this.activePreviewStrokeVisible = false;
}

  _attachStrokeRenderable(patch, stroke) {
    const positions = new Float32Array(stroke.points.length * 3);

    for (let i = 0; i < stroke.points.length; i += 1) {
      const point = stroke.points[i];
      this._localToWorld(patch, point, this.tempWorldPoint);
      const idx = i * 3;
      positions[idx] = this.tempWorldPoint.x;
      positions[idx + 1] = this.tempWorldPoint.y;
      positions[idx + 2] = this.tempWorldPoint.z;
    }

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    const material = new LineMaterial({
  color: stroke.color,
  linewidth: stroke.thickness,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  toneMapped: true
});
    material.resolution.set(this.viewportWidth, this.viewportHeight);

    const line = new Line2(geometry, material);
    line.computeLineDistances();
    const renderOrder = Number.isFinite(stroke.renderOrder) ? stroke.renderOrder : this._nextStrokeRenderOrder();
    line.renderOrder = renderOrder;
    stroke.renderOrder = renderOrder;
    this.strokeRenderOrderCounter = Math.max(this.strokeRenderOrderCounter, renderOrder);
    line.frustumCulled = false

    patch.group.add(line);

    stroke.renderable = line;
    this.lineMaterials.add(material);
  }

_bakeOldStrokes(patch) {
  this._ensureBakedLayer(patch);

  if (!patch.bakedLayer) {
    return;
  }

  const strokesToBake = patch.liveStrokes.splice(0, patch.liveStrokes.length);

  for (const stroke of strokesToBake) {
    patch.strokeArchive.set(stroke.id, stroke);
    this._disposeStrokeRenderable(stroke);
  }

  this._renderPatchCanvas(patch);
}
_getTextureLineWidth(patch, canvas, stroke) {
  const worldWidth = Math.max(0.001, patch.maxX - patch.minX);
  const pixelsPerWorldUnit = canvas.width / worldWidth;

  return Math.max(
    1,
    stroke.thickness * pixelsPerWorldUnit * this.textureBrushScale
  );
}

_drawStrokeToPatchCanvas(patch, stroke) {
  if (!patch?.bakedLayer || !stroke?.points || stroke.points.length < 2) {
    return;
  }

  const { ctx, canvas } = patch.bakedLayer;

  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = this._getTextureLineWidth(patch, canvas, stroke);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let i = 0; i < stroke.points.length; i += 1) {
    const point = stroke.points[i];

    const px =
      ((point.x - patch.minX) / Math.max(0.001, patch.maxX - patch.minX)) *
      canvas.width;

    const py =
      (1 - ((point.y - patch.minY) / Math.max(0.001, patch.maxY - patch.minY))) *
      canvas.height;

    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.stroke();
}

_renderPatchCanvas(patch, previewStroke = null) {
  if (!patch?.bakedLayer) {
    return;
  }

  const { ctx, canvas, texture } = patch.bakedLayer;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;

  for (const stroke of patch.strokeArchive.values()) {
    this._drawStrokeToPatchCanvas(patch, stroke);
  }

  if (previewStroke) {
    this._drawStrokeToPatchCanvas(patch, previewStroke);
  }

  texture.needsUpdate = true;
}
  _ensureBakedLayer(patch) {
    if (patch.bakedLayer) {
      return;
    }
const canvas = document.createElement('canvas');
canvas.width = this.bakedTextureSize;
canvas.height = this.bakedTextureSize;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

const material = new THREE.MeshBasicMaterial({
  map: texture,
  transparent: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -1
});

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(this.patchSize, this.patchSize),
      material
    );

    this.tempBasisMatrix.makeBasis(patch.tangent, patch.bitangent, patch.normal);
    plane.quaternion.setFromRotationMatrix(this.tempBasisMatrix);
    plane.scale.set((patch.halfWidth * 2) / this.patchSize, (patch.halfHeight * 2) / this.patchSize, 1);
    plane.position.copy(patch.center).addScaledVector(patch.normal, this.surfaceOffset * 0.7);
    plane.renderOrder = 1;

    patch.group.add(plane);
    patch.bakedLayer = { canvas, ctx, texture, plane };
  }

_eraseAtPoint(localPoint) {
  if (!this.activePatch) return;

  const eraseRadius = clamp(this.uiManager.getBrushSize() * 0.03, 0.06, 0.45);
  const removedIds = [];
  const removedSnapshots = [];

  const strokes = Array.from(this.activePatch.strokeArchive.values());

  for (const stroke of strokes) {
    const distance = minDistanceToPolyline(localPoint, stroke.points);

    if (distance <= eraseRadius) {
      removedSnapshots.push(this._snapshotStrokeForUndo(stroke, this.activePatch));
      removedIds.push(stroke.id);
    }
  }

  if (removedIds.length > 0) {
    this._doAction({
      type: 'erase',
      patchKey: this.activePatch.key,
      strokes: removedSnapshots
    });

    const packet = {
      id: this._nextStrokeId(),
      erase: true,
      patchKey: this.activePatch.key,
      targets: removedIds,
      createdAt: Date.now()
    };

    this.seenStrokeIds.add(packet.id);
    this.sendStrokeCallback(packet);
  }
}
  _applyErasePacket(packet) {
    if (!Array.isArray(packet.targets)) {
      return;
    }

    for (const id of packet.targets) {
      const indexed = this.strokeIndex.get(id);
      if (!indexed) {
        continue;
      }

      const patch = this.patches.get(indexed.patchKey);
      if (!patch) {
        continue;
      }

      this._removeStrokeFromPatch(patch, id);
    }
  }

  _snapshotStrokeForUndo(stroke, patch) {
    return {
      id: stroke.id,
      color: stroke.color,
      thickness: stroke.thickness,
      createdAt: stroke.createdAt,
      playerId: stroke.playerId || null,
      renderOrder: stroke.renderable?.renderOrder ?? stroke.renderOrder ?? null,
      patchKey: patch.key,
      patch: {
        key: patch.key,
        meshId: patch.meshId,
        center: [patch.center.x, patch.center.y, patch.center.z],
        normal: [patch.normal.x, patch.normal.y, patch.normal.z],
        tangent: [patch.tangent.x, patch.tangent.y, patch.tangent.z],
        bitangent: [patch.bitangent.x, patch.bitangent.y, patch.bitangent.z],
        halfSize: patch.halfSize,
        halfWidth: patch.halfWidth,
        halfHeight: patch.halfHeight,
        minX: patch.minX,
        maxX: patch.maxX,
        minY: patch.minY,
        maxY: patch.maxY
      },
      points: stroke.points.map((point) => ({ x: point.x, y: point.y }))
    };
  }



  _removeStrokeFromPatch(patch, strokeId) {
    if (!patch || !strokeId) {
      return false;
    }

    const stroke = patch.strokeArchive?.get(strokeId) || this.strokeIndex.get(strokeId)?.stroke || null;
    if (!stroke) {
      return false;
    }

    const liveIndex = patch.liveStrokes.findIndex((entry) => entry.id === strokeId);
    if (liveIndex !== -1) {
      const [liveStroke] = patch.liveStrokes.splice(liveIndex, 1);
      this._disposeStrokeRenderable(liveStroke);
    }

    patch.strokeArchive?.delete(strokeId);
    this.strokeIndex.delete(strokeId);

    if (patch.bakedLayer) {
      this._rebuildBakedLayer(patch);
    }

    return true;
  }
_rebuildBakedLayer(patch) {
  this._renderPatchCanvas(patch);
}


  _disposeStrokeRenderable(stroke) {
    if (!stroke.renderable) {
      return;
    }

    const { geometry, material } = stroke.renderable;
    if (stroke.renderable.parent) {
      stroke.renderable.parent.remove(stroke.renderable);
    }
    if (geometry) {
      geometry.dispose();
    }
    if (material) {
      this.lineMaterials.delete(material);
      material.dispose();
    }

    stroke.renderable = null;
  }

  _encodeStrokePacket(patch, stroke) {
    return {
      v: 1,
      id: stroke.id,
      patchKey: patch.key,
      patch: {
        key: patch.key,
        meshId: patch.meshId,
        center: [patch.center.x, patch.center.y, patch.center.z],
        normal: [patch.normal.x, patch.normal.y, patch.normal.z],
        tangent: [patch.tangent.x, patch.tangent.y, patch.tangent.z],
        bitangent: [patch.bitangent.x, patch.bitangent.y, patch.bitangent.z],
        halfSize: patch.halfSize,
        halfWidth: patch.halfWidth,
        halfHeight: patch.halfHeight,
        minX: patch.minX,
        maxX: patch.maxX,
        minY: patch.minY,
        maxY: patch.maxY
      },
      color: stroke.color,
      thickness: stroke.thickness,
      q: this.quantization,
      points: this._encodePoints(stroke.points, this.quantization),
      createdAt: stroke.createdAt
    };
  }

  _encodePoints(points, quantization) {
    const encoded = new Array(points.length * 2);
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      encoded[i * 2] = Math.round(point.x * quantization);
      encoded[i * 2 + 1] = Math.round(point.y * quantization);
    }
    return encoded;
  }

  _decodePoints(encoded, quantization) {
    const points = [];
    for (let i = 0; i < encoded.length - 1; i += 2) {
      points.push({
        x: encoded[i] / quantization,
        y: encoded[i + 1] / quantization
      });
    }
    return points;
  }

  _localToWorld(patch, localPoint, out) {
    out.copy(patch.center)
      .addScaledVector(patch.tangent, localPoint.x)
      .addScaledVector(patch.bitangent, localPoint.y)
      .addScaledVector(patch.normal, this.surfaceOffset);
    return out;
  }

  _updatePointerNdc(event) {
    const rect = this.rendererSystem.getDomElement().getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.hasPointer = true;
    this.pointerDirtySinceScan = true;
  }

  _createPreviewMesh() {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      wireframe: false
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.patchSize, this.patchSize), material);
    mesh.visible = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  _createDrawBoundaryMesh() {
    const half = this.patchHalfSize;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -half, -half, 0,
      half, -half, 0,
      half, half, 0,
      -half, half, 0
    ], 3));

    const material = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: this.patchSize * 0.12,
      gapSize: this.patchSize * 0.07,
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.dashOffset = { value: 0 };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'uniform float totalSize;',
          'uniform float totalSize;\nuniform float dashOffset;'
        )
        .replace(
          'if ( mod( vLineDistance, totalSize ) > dashSize ) {',
          'if ( mod( vLineDistance + dashOffset, totalSize ) > dashSize ) {'
        );

      material.userData.dashShader = shader;
    };

    const loop = new THREE.LineLoop(geometry, material);
    loop.computeLineDistances();
    loop.visible = false;
    loop.renderOrder = 4;
    return loop;
  }

  _updatePreviewMesh(descriptor) {
    this.previewMesh.visible = false;
  }

  _updateDrawBoundaryMesh(descriptor) {
    if (!descriptor) {
      this.drawBoundaryMesh.visible = false;
      return;
    }

    this.tempBasisMatrix.makeBasis(descriptor.tangent, descriptor.bitangent, descriptor.normal);
    this.drawBoundaryMesh.quaternion.setFromRotationMatrix(this.tempBasisMatrix);
    this.drawBoundaryMesh.scale.set(
      (descriptor.halfWidth * 2) / this.patchSize,
      (descriptor.halfHeight * 2) / this.patchSize,
      1
    );
    this.drawBoundaryMesh.position.copy(descriptor.center).addScaledVector(descriptor.normal, this.surfaceOffset * 1.05);
    this.drawBoundaryMesh.visible = true;
  }

  _nextStrokeId() {
    this.strokeCounter += 1;
    return `s-${Date.now().toString(36)}-${this.strokeCounter.toString(36)}`;
  }
}
