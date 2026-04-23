import * as THREE from '../vendor/three/build/three.module.js';
import { Line2 } from '../vendor/three/examples/jsm/lines/Line2.js';
import { LineMaterial } from '../vendor/three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from '../vendor/three/examples/jsm/lines/LineGeometry.js';
import { clamp, roundToStep } from '../utils/math.js';
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
    this.worldUp = new THREE.Vector3(0, 1, 0);
    this.altUp = new THREE.Vector3(1, 0, 0);

    this.patchSize = 4;
    this.patchHalfSize = this.patchSize * 0.5;
    this.surfaceOffset = 0.02;
    this.drawPromptMaxDistance = 11.5;

    this.quantization = 1000;
    this.maxPointsPerStroke = 280;
    this.minDistanceBetweenPoints = 0.03;
    this.simplificationEpsilon = 0.02;
    this.maxLiveStrokesPerPatch = 48;
    this.bakeBatchSize = 20;

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

    this.patches = new Map();
    this.strokeIndex = new Map();
    this.seenStrokeIds = new Set();
    this.lineMaterials = new Set();

    this.sendStrokeCallback = () => {};
    this.strokeCounter = 0;
    this.hasPointer = false;

    this.previewMesh = this._createPreviewMesh();
    this.scene.add(this.previewMesh);

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

  update(deltaSeconds) {
    if (this.drawMode) {
      this.uiManager.setDrawPrompt(true, 'Drawing mode - hold mouse to paint, Esc to exit');
      return;
    }

    this.wallScanAccumulator += deltaSeconds;
    if (this.wallScanAccumulator < 0.03) {
      return;
    }
    this.wallScanAccumulator = 0;

    const hit = this._findWallInFront() || this._findWallAtPointer();
    if (!hit) {
      this.currentCandidate = null;
      this.previewMesh.visible = false;
      this.uiManager.setDrawPrompt(false);
      return;
    }

    const descriptor = this._buildPatchDescriptor(hit);
    this.currentCandidate = descriptor;
    this._updatePreviewMesh(descriptor);
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
      playerId: packet.playerId || null
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
        createdAt: Date.now()
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
    this.uiManager.setDrawMode(false);
    this.uiManager.setDrawPrompt(false);
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

    const snappedU = roundToStep(rawU, this.patchSize);
    const snappedV = roundToStep(rawV, this.patchSize);

    this.tempCenter
      .copy(this.tempTangent).multiplyScalar(snappedU)
      .addScaledVector(this.tempBitangent, snappedV)
      .addScaledVector(this.tempNormal, planeDistance);

    const key = `${hit.object.id}:${Math.round(snappedU * 10)}:${Math.round(snappedV * 10)}`;

    return {
      key,
      meshId: hit.object.id,
      center: this.tempCenter.clone(),
      normal: this.tempNormal.clone(),
      tangent: this.tempTangent.clone(),
      bitangent: this.tempBitangent.clone(),
      halfSize: this.patchHalfSize
    };
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
      group,
      liveStrokes: [],
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
      halfSize: Number(packetPatch.halfSize) || this.patchHalfSize
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

    const localX = clamp(this.tempVec.dot(this.activePatch.tangent), -this.activePatch.halfSize, this.activePatch.halfSize);
    const localY = clamp(this.tempVec.dot(this.activePatch.bitangent), -this.activePatch.halfSize, this.activePatch.halfSize);

    return { x: localX, y: localY };
  }

  _insertStroke(patch, stroke, emitNetwork) {
    this._attachStrokeRenderable(patch, stroke);

    patch.liveStrokes.push(stroke);
    this.strokeIndex.set(stroke.id, { patchKey: patch.key, stroke });
    this.seenStrokeIds.add(stroke.id);

    if (patch.liveStrokes.length > this.maxLiveStrokesPerPatch) {
      this._bakeOldStrokes(patch);
    }

    if (emitNetwork) {
      this.sendStrokeCallback(this._encodeStrokePacket(patch, stroke));
    }
  }

  _updateActiveStrokeRenderable() {
    if (!this.activePatch || this.activeStroke.length < 1 || !this.activePreviewPoint) {
      this._clearActiveStrokeRenderable();
      return;
    }

    const positions = new Float32Array((this.activeStroke.length + 1) * 3);
    for (let i = 0; i < this.activeStroke.length; i += 1) {
      const point = this.activeStroke[i];
      this._localToWorld(this.activePatch, point, this.tempWorldPoint);
      const idx = i * 3;
      positions[idx] = this.tempWorldPoint.x;
      positions[idx + 1] = this.tempWorldPoint.y;
      positions[idx + 2] = this.tempWorldPoint.z;
    }

    this._localToWorld(this.activePatch, this.activePreviewPoint, this.tempWorldPoint);
    const previewIdx = this.activeStroke.length * 3;
    positions[previewIdx] = this.tempWorldPoint.x;
    positions[previewIdx + 1] = this.tempWorldPoint.y;
    positions[previewIdx + 2] = this.tempWorldPoint.z;

    if (!this.activeStrokeRenderable || this.activeStrokePatchKey !== this.activePatch.key) {
      this._clearActiveStrokeRenderable();

      const geometry = new LineGeometry();
      const material = new LineMaterial({
        color: this.uiManager.getBrushColor(),
        linewidth: clamp(this.uiManager.getBrushSize(), 1, 24),
        transparent: true,
        depthWrite: false,
        toneMapped: true,
        polygonOffset: true,
        polygonOffsetFactor: -2
      });
      material.resolution.set(this.viewportWidth, this.viewportHeight);

      this.activeStrokeRenderable = new Line2(geometry, material);
      this.activeStrokeRenderable.renderOrder = 2;
      this.activeStrokeRenderable.frustumCulled = true;
      this.activeStrokePatchKey = this.activePatch.key;

      this.activePatch.group.add(this.activeStrokeRenderable);
      this.lineMaterials.add(material);
    } else {
      const liveMaterial = this.activeStrokeRenderable.material;
      if (liveMaterial?.color) {
        liveMaterial.color.set(this.uiManager.getBrushColor());
      }
      if (liveMaterial) {
        liveMaterial.linewidth = clamp(this.uiManager.getBrushSize(), 1, 24);
      }
    }

    this.activeStrokeRenderable.geometry.setPositions(positions);
    this.activeStrokeRenderable.computeLineDistances();
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
        x: clamp(candidate.x, -this.patchHalfSize, this.patchHalfSize),
        y: clamp(candidate.y, -this.patchHalfSize, this.patchHalfSize)
      };

      if (clamped.x !== localPoint.x || clamped.y !== localPoint.y) {
        return clamped;
      }
    }

    return { x: localPoint.x + offset, y: localPoint.y };
  }

  _clearActiveStrokeRenderable() {
    if (!this.activeStrokeRenderable) {
      this.activeStrokePatchKey = null;
      return;
    }

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

    this.activeStrokeRenderable = null;
    this.activeStrokePatchKey = null;
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
      depthWrite: false,
      toneMapped: true,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    material.resolution.set(this.viewportWidth, this.viewportHeight);

    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 2;
    line.frustumCulled = true;

    patch.group.add(line);

    stroke.renderable = line;
    this.lineMaterials.add(material);
  }

  _bakeOldStrokes(patch) {
    this._ensureBakedLayer(patch);

    if (!patch.bakedLayer) {
      return;
    }

    const count = Math.min(this.bakeBatchSize, patch.liveStrokes.length);
    const strokesToBake = patch.liveStrokes.splice(0, count);

    const { ctx, canvas, texture } = patch.bakedLayer;
    for (const stroke of strokesToBake) {
      if (!stroke.points || stroke.points.length < 2) {
        continue;
      }

      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = Math.max(1, stroke.thickness * 2);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (let i = 0; i < stroke.points.length; i += 1) {
        const point = stroke.points[i];
        const px = ((point.x / patch.halfSize) * 0.5 + 0.5) * canvas.width;
        const py = ((-point.y / patch.halfSize) * 0.5 + 0.5) * canvas.height;
        if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      }

      ctx.stroke();

      this._disposeStrokeRenderable(stroke);
      this.strokeIndex.delete(stroke.id);
    }

    texture.needsUpdate = true;
  }

  _ensureBakedLayer(patch) {
    if (patch.bakedLayer) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.85,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1
    });

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(patch.halfSize * 2, patch.halfSize * 2),
      material
    );

    this.tempBasisMatrix.makeBasis(patch.tangent, patch.bitangent, patch.normal);
    plane.quaternion.setFromRotationMatrix(this.tempBasisMatrix);
    plane.position.copy(patch.center).addScaledVector(patch.normal, this.surfaceOffset * 0.7);
    plane.renderOrder = 1;

    patch.group.add(plane);
    patch.bakedLayer = { canvas, ctx, texture, plane };
  }

  _eraseAtPoint(localPoint) {
    if (!this.activePatch) {
      return;
    }

    const eraseRadius = clamp(this.uiManager.getBrushSize() * 0.03, 0.06, 0.45);
    const removedIds = [];

    for (let i = this.activePatch.liveStrokes.length - 1; i >= 0; i -= 1) {
      const stroke = this.activePatch.liveStrokes[i];
      const distance = minDistanceToPolyline(localPoint, stroke.points);
      if (distance <= eraseRadius) {
        this.activePatch.liveStrokes.splice(i, 1);
        this._disposeStrokeRenderable(stroke);
        this.strokeIndex.delete(stroke.id);
        removedIds.push(stroke.id);
      }
    }

    if (removedIds.length > 0) {
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

      const idx = patch.liveStrokes.findIndex((stroke) => stroke.id === id);
      if (idx !== -1) {
        const [stroke] = patch.liveStrokes.splice(idx, 1);
        this._disposeStrokeRenderable(stroke);
      }

      this.strokeIndex.delete(id);
    }
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
        halfSize: patch.halfSize
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
  }

  _createPreviewMesh() {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
      side: THREE.DoubleSide,
      wireframe: true
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.patchSize, this.patchSize), material);
    mesh.visible = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  _updatePreviewMesh(descriptor) {
    this.tempBasisMatrix.makeBasis(descriptor.tangent, descriptor.bitangent, descriptor.normal);
    this.previewMesh.quaternion.setFromRotationMatrix(this.tempBasisMatrix);
    this.previewMesh.position.copy(descriptor.center).addScaledVector(descriptor.normal, this.surfaceOffset * 0.8);
    this.previewMesh.visible = true;
  }

  _nextStrokeId() {
    this.strokeCounter += 1;
    return `s-${Date.now().toString(36)}-${this.strokeCounter.toString(36)}`;
  }
}
