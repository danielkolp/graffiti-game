import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from '../vendor/three/examples/jsm/utils/SkeletonUtils.js';
import { clamp, damp } from '../utils/math.js';

const PLAYABLE_STATES = ['idle', 'walk', 'run'];
const QUARTER_TURN = Math.PI * 0.5;
const PLAYER_MODEL_CANDIDATES = [
  'models/idkbro.glb',
  './models/idkbro.glb',
  '../models/idkbro.glb',
  '../../models/idkbro.glb',
  '/models/idkbro.glb'
];
const PLAYER_LOAD_TIMEOUT_MS = 15000;
const DEFAULT_PLAYER_COLOR = '#1b69fa';
const DEFAULT_PLAYER_NAME = 'Writer';
const CHAT_BUBBLE_DURATION_MS = 5000;
const CHAT_BUBBLE_MAX_CHARS = 140;
const PLAYER_NAME_MAX_CHARS = 18;

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function dampAngle(current, target, lambda, dt) {
  const delta = normalizeAngle(target - current);
  return normalizeAngle(current + (delta * (1 - Math.exp(-lambda * dt))));
}

function angleDistance(a, b) {
  return Math.abs(normalizeAngle(a - b));
}

function quantizeQuarterTurn(angle) {
  const normalized = normalizeAngle(angle);
  const candidates = [0, QUARTER_TURN, -QUARTER_TURN, Math.PI];

  let best = candidates[0];
  let bestDistance = angleDistance(normalized, best);

  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const distance = angleDistance(normalized, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return normalizeAngle(best);
}

function isAnimationDebugEnabled() {
  if (globalThis.__animDebug === true) {
    return true;
  }

  if (typeof window === 'undefined' || !window.location) {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get('animDebug') === '1';
}

function normalizeHexColor(value, fallback = DEFAULT_PLAYER_COLOR) {
  const input = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(input) ? input : fallback;
}

function lightenHexColor(hexColor, mix = 0.45) {
  const safe = normalizeHexColor(hexColor);
  const base = new THREE.Color(safe);
  const out = base.clone().lerp(new THREE.Color('#ffffff'), clamp(mix, 0, 1));
  return `#${out.getHexString()}`;
}

function sanitizePlayerName(value, fallback = DEFAULT_PLAYER_NAME) {
  const collapsed = String(value || '').replace(/\s+/g, ' ').trim().slice(0, PLAYER_NAME_MAX_CHARS);
  return collapsed || fallback;
}

function buildFallbackCharacter(baseColor = DEFAULT_PLAYER_COLOR) {
  const safeBase = normalizeHexColor(baseColor);
  const headColor = lightenHexColor(safeBase, 0.56);
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.38, 1.05, 8, 16),
    new THREE.MeshStandardMaterial({ color: safeBase, roughness: 0.72, metalness: 0.08 })
  );
  body.castShadow = true;
  body.receiveShadow = false;
  body.position.y = 1.0;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 16, 16),
    new THREE.MeshStandardMaterial({ color: headColor, roughness: 0.8, metalness: 0.04 })
  );
  head.position.set(0, 1.95, 0);
  head.castShadow = true;
  group.add(head);

  return group;
}

class RemotePlayerPool {
  constructor() {
    this.available = [];
  }

  acquire(baseColor = DEFAULT_PLAYER_COLOR) {
    if (this.available.length > 0) {
      const reused = this.available.pop();
      const mesh = reused.children[0];
      if (mesh?.material?.color) {
        mesh.material.color.set(normalizeHexColor(baseColor));
      }
      return reused;
    }

    const root = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 1.05, 8, 16),
      new THREE.MeshStandardMaterial({
        color: normalizeHexColor(baseColor),
        roughness: 0.75,
        metalness: 0.05
      })
    );
    mesh.castShadow = true;
    mesh.position.y = 1.0;
    root.add(mesh);
    return root;
  }

  release(object3D) {
    object3D.visible = false;
    object3D.position.set(0, -9999, 0);
    this.available.push(object3D);
  }
}

export class PlayerController {
  constructor(scene, loadingManager) {
    this.scene = scene;
    this.loadingManager = loadingManager;
    this.loader = new GLTFLoader(loadingManager);

    this.localPlayer = new THREE.Group();
    this.localPlayer.position.set(0, 0.05, 0);
    this.localPlayer.name = 'LocalPlayer';
    this.scene.add(this.localPlayer);

    this.localVisual = null;
    this.mixer = null;
    this.actions = {};
    this.currentAction = null;
    this.currentState = 'idle';
    this.previousState = 'idle';

    this.targetRotation = 0;
    this.minMoveRotateSpeedSq = 0.02;
    this.visualOffsetY = 0;
    this.modelFacingOffset = 0;
    this.facingCalibrated = false;
    this.facingReferenceNode = null;

    this.alignmentPending = true;
    this.alignmentMinSpeed = 0.8;
    this.alignmentStableFrames = 0;
    this.alignmentStableFramesRequired = 6;
    this.alignmentSampleCount = 0;
    this.alignmentSamplesRequired = 6;
    this.alignmentOffsetSinSum = 0;
    this.alignmentOffsetCosSum = 0;

    this.walkReferenceSpeed = 4.2;
    this.runReferenceSpeed = 7.4;

    this.jumpLockActive = false;
    this.groundedFrameStreak = 0;
    this.previousOnGround = null;
    this.stableGroundFrames = 0;
    this.hasStableGroundContact = false;
    this.jumpFrameTakeoff = 10;
    this.jumpFrameApex = 20;
    this.jumpFrameLand = 30;
    this.jumpFrameRecover = 45;

    this.debugAnimations = isAnimationDebugEnabled();

    this.tempQuat = new THREE.Quaternion();
    this.tempForward = new THREE.Vector3();
    this.tempWorldAnchor = new THREE.Vector3();
    this.tempBounds = new THREE.Box3();
    this.tempBoundsSize = new THREE.Vector3();

    this.remotePlayers = new Map();
    this.remotePool = new RemotePlayerPool();
    this.remoteStateOrder = ['idle', 'walk', 'run'];
    this.remoteClipMap = {};
    this.remoteTemplateReady = false;
    this.tempRemotePrevPos = new THREE.Vector3();
    this.localPlayerColor = DEFAULT_PLAYER_COLOR;
    this.localPlayerName = DEFAULT_PLAYER_NAME;
    this.localPlayerId = null;
    this.localChatBubble = null;
    this.localNameTag = null;
    this.pendingRemoteChat = new Map();
    this.pendingRemoteTyping = new Map();
    this.pendingRemoteColors = new Map();
    this.pendingRemoteNames = new Map();
  }

  getLocalPlayer() {
    return this.localPlayer;
  }

  getLocalNetworkState() {
    return {
      position: {
        x: this.localPlayer.position.x,
        y: this.localPlayer.position.y,
        z: this.localPlayer.position.z
      },
      rotationY: this.localPlayer.rotation.y,
      color: this.localPlayerColor,
      name: this.localPlayerName,
      timestamp: Date.now()
    };
  }

  setLocalPlayerId(playerId) {
    this.localPlayerId = playerId || null;
  }

  setLocalPlayerColor(colorHex) {
    this.localPlayerColor = normalizeHexColor(colorHex);
    if (this.localVisual) {
      this._applyColorToVisual(this.localVisual, this.localPlayerColor);
    }
  }

  setLocalPlayerName(name) {
    this.localPlayerName = sanitizePlayerName(name);
    this._setNameTagText(this.localNameTag, this.localPlayerName);
  }

  setLocalChatMessage(message, durationMs = CHAT_BUBBLE_DURATION_MS) {
    this._setChatBubbleMessage(this.localChatBubble, message, durationMs);
  }

  setLocalTyping(typing) {
    this._setChatBubbleTyping(this.localChatBubble, typing === true);
  }

  setRemoteChatMessage(playerId, message, durationMs = CHAT_BUBBLE_DURATION_MS) {
    const remote = this.remotePlayers.get(playerId);
    if (!remote) {
      this.pendingRemoteChat.set(playerId, {
        message: String(message || '').trim().slice(0, CHAT_BUBBLE_MAX_CHARS),
        durationMs
      });
      return;
    }
    this._setChatBubbleMessage(remote.chatBubble, message, durationMs);
  }

  setRemoteTyping(playerId, typing) {
    const remote = this.remotePlayers.get(playerId);
    if (!remote) {
      this.pendingRemoteTyping.set(playerId, typing === true);
      return;
    }
    this._setChatBubbleTyping(remote.chatBubble, typing === true);
  }

  setRemotePlayerName(playerId, name) {
    const remote = this.remotePlayers.get(playerId);
    const safe = sanitizePlayerName(name);
    if (!remote) {
      this.pendingRemoteNames.set(playerId, safe);
      return;
    }
    remote.name = safe;
    this._setNameTagText(remote.nameTag, safe);
  }

  setRemotePlayerColor(playerId, colorHex) {
    const remote = this.remotePlayers.get(playerId);
    const safe = normalizeHexColor(colorHex);
    if (!remote) {
      this.pendingRemoteColors.set(playerId, safe);
      return;
    }
    this._setRemotePlayerColor(remote, safe);
  }

  async loadLocalPlayer() {
    try {
      const gltf = await this._loadPlayerModelWithCandidates();

      this.localVisual = gltf.scene;
      this.localVisual.scale.setScalar(1.5);
      this.localVisual.position.set(0, this.visualOffsetY, 0);
      this.localVisual.rotation.set(0, 0, 0);

      this.localVisual.traverse((node) => {
        if (!node.isMesh) {
          return;
        }

        node.castShadow = true;
        node.receiveShadow = false;
        node.frustumCulled = true;

        if (!node.material) {
          return;
        }

        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (material.isMeshStandardMaterial) {
            material.roughness = 0.68;
            material.metalness = 0.08;
          }
        }
      });
      this._isolateVisualMaterials(this.localVisual);
      this._applyColorToVisual(this.localVisual, this.localPlayerColor);

      this.localPlayer.add(this.localVisual);
      this.localPlayer.userData.labelAnchorY = this._estimateLabelAnchorY(this.localPlayer);
      this.localChatBubble = this._attachChatBubble(this.localPlayer);
      this.localNameTag = this._attachNameTag(this.localPlayer);
      this._setNameTagText(this.localNameTag, this.localPlayerName);
      this.facingReferenceNode = this._findFacingReferenceNode();
      this.facingCalibrated = false;
      this.alignmentPending = true;
      this._resetFacingAlignmentSampling();
      this._setupAnimations(gltf.animations || []);
      this._prepareRemoteTemplate(gltf.animations || []);
      this._upgradeRemotePlayersToModel();
    } catch (error) {
      console.error('Failed to load player model, using fallback:', error);
      this.localVisual = buildFallbackCharacter(this.localPlayerColor);
      this.localVisual.position.set(0, this.visualOffsetY, 0);
      this.localPlayer.add(this.localVisual);
      this.localPlayer.userData.labelAnchorY = this._estimateLabelAnchorY(this.localPlayer);
      this.localChatBubble = this._attachChatBubble(this.localPlayer);
      this.localNameTag = this._attachNameTag(this.localPlayer);
      this._setNameTagText(this.localNameTag, this.localPlayerName);
    }
  }

  async _loadPlayerModelWithCandidates() {
    const errors = [];

    for (const candidateUrl of PLAYER_MODEL_CANDIDATES) {
      try {
        return await this._withTimeout(
          this.loader.loadAsync(candidateUrl),
          PLAYER_LOAD_TIMEOUT_MS
        );
      } catch (error) {
        errors.push(`${candidateUrl}: ${error.message || String(error)}`);
      }
    }

    throw new Error(`All model URLs failed. ${errors.join(' | ')}`);
  }

  _withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  update(deltaSeconds, movementState = {}, options = {}) {
    const dt = Math.max(0, Math.min(deltaSeconds || 0, 0.05));
    const input = this._buildAnimationInput(movementState);

    this._updateJumpLock(input);

    const nextState = this._resolveAnimationState(input);
    this._transitionToState(nextState, input);
    this._syncLocomotionTimescale(input);

    if (this.mixer) {
      this.mixer.update(dt);
    }

    this._autoAlignFacing(input);
    this._updateMovementRotation(input, dt, options.drawMode === true);
    this._updateRemotePlayers(dt);
    this._updateChatBubble(this.localChatBubble, Date.now());
    this._updateLabelAnchors();
  }

  upsertRemotePlayer(playerId, snapshot) {
    let remote = this.remotePlayers.get(playerId);

    if (!remote) {
      remote = this._createRemotePlayerInstance(playerId, snapshot);
      remote.object3D.visible = true;
      if (snapshot?.position) {
        remote.object3D.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
        remote.targetPosition.copy(remote.object3D.position);
      }
      if (typeof snapshot?.rotationY === 'number') {
        remote.object3D.rotation.y = snapshot.rotationY;
        remote.targetRotationY = snapshot.rotationY;
      }
      if (typeof snapshot?.color === 'string') {
        remote.color = normalizeHexColor(snapshot.color);
      }
      if (typeof snapshot?.name === 'string') {
        remote.name = sanitizePlayerName(snapshot.name);
      }
      remote.lastPosition.copy(remote.object3D.position);
      remote.lastUpdateAt = Date.now();
      remote.estimatedSpeed = 0;
      this.scene.add(remote.object3D);
      this.remotePlayers.set(playerId, remote);
      this._applyPendingRemoteUi(playerId, remote);
    }

    if (snapshot.position) {
      remote.targetPosition.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    }
    if (typeof snapshot.rotationY === 'number') {
      remote.targetRotationY = snapshot.rotationY;
    }
    if (typeof snapshot.color === 'string') {
      this._setRemotePlayerColor(remote, snapshot.color);
    }
    if (typeof snapshot.name === 'string') {
      remote.name = sanitizePlayerName(snapshot.name);
      this._setNameTagText(remote.nameTag, remote.name);
    }
    remote.lastSeen = Date.now();
  }

  removeRemotePlayer(playerId) {
    const remote = this.remotePlayers.get(playerId);
    if (!remote) {
      return;
    }

    this.scene.remove(remote.object3D);
    if (remote.usesFallback) {
      this.remotePool.release(remote.object3D);
    }
    this.remotePlayers.delete(playerId);
  }

  _applyPendingRemoteUi(playerId, remote) {
    if (!remote) {
      return;
    }

    if (this.pendingRemoteColors.has(playerId)) {
      const color = this.pendingRemoteColors.get(playerId);
      this._setRemotePlayerColor(remote, color);
      this.pendingRemoteColors.delete(playerId);
    }

    if (this.pendingRemoteNames.has(playerId)) {
      const name = this.pendingRemoteNames.get(playerId);
      remote.name = sanitizePlayerName(name);
      this._setNameTagText(remote.nameTag, remote.name);
      this.pendingRemoteNames.delete(playerId);
    }

    if (this.pendingRemoteTyping.has(playerId)) {
      this._setChatBubbleTyping(remote.chatBubble, this.pendingRemoteTyping.get(playerId) === true);
      this.pendingRemoteTyping.delete(playerId);
    }

    if (this.pendingRemoteChat.has(playerId)) {
      const pending = this.pendingRemoteChat.get(playerId);
      if (pending?.message) {
        this._setChatBubbleMessage(remote.chatBubble, pending.message, pending.durationMs);
      }
      this.pendingRemoteChat.delete(playerId);
    }
  }

  _updateRemotePlayers(deltaSeconds) {
    const now = Date.now();
    for (const [playerId, remote] of this.remotePlayers.entries()) {
      this.tempRemotePrevPos.copy(remote.object3D.position);
      remote.object3D.position.lerp(remote.targetPosition, 1 - Math.exp(-12 * deltaSeconds));
      remote.object3D.rotation.y = damp(remote.object3D.rotation.y, remote.targetRotationY, 12, deltaSeconds);

      const movedDistance = remote.object3D.position.distanceTo(this.tempRemotePrevPos);
      const frameSpeed = movedDistance / Math.max(0.0001, deltaSeconds);
      remote.estimatedSpeed = damp(remote.estimatedSpeed || 0, frameSpeed, 8, deltaSeconds);
      this._updateRemoteAnimation(remote, deltaSeconds);
      this._updateChatBubble(remote.chatBubble, now);

      if (now - remote.lastSeen > 15000) {
        this.removeRemotePlayer(playerId);
      }
    }
  }

  _prepareRemoteTemplate(clips) {
    const clipMap = this._resolveAnimationClips(clips);
    const remoteClipMap = {};

    for (const stateName of this.remoteStateOrder) {
      const sourceClip = clipMap[stateName];
      if (!sourceClip) {
        continue;
      }

      const preprocessed = this._preprocessClip(sourceClip, `remote_${stateName}`);
      if (!preprocessed) {
        continue;
      }

      remoteClipMap[stateName] = preprocessed;
    }

    this.remoteClipMap = remoteClipMap;
    this.remoteTemplateReady = !!this.localVisual;
  }

  _createRemotePlayerInstance(playerId, snapshot = null) {
    let object3D = null;
    let usesFallback = false;
    const desiredColor = normalizeHexColor(snapshot?.color || this.pendingRemoteColors.get(playerId) || this.localPlayerColor);
    const desiredName = sanitizePlayerName(snapshot?.name || this.pendingRemoteNames.get(playerId) || DEFAULT_PLAYER_NAME);

    if (this.remoteTemplateReady && this.localVisual) {
      try {
        const root = new THREE.Group();
        root.name = `RemotePlayer-${playerId}`;
        const visual = cloneSkeleton(this.localVisual);
        visual.position.set(0, this.visualOffsetY, 0);
        visual.rotation.set(0, 0, 0);
        this._isolateVisualMaterials(visual);
        root.add(visual);
        object3D = root;
      } catch (error) {
        console.warn('Remote player model clone failed, falling back to capsule:', error);
      }
    }

    if (!object3D) {
      object3D = this.remotePool.acquire(desiredColor);
      usesFallback = true;
    }

    const remote = {
      id: playerId,
      object3D,
      targetPosition: new THREE.Vector3(),
      targetRotationY: 0,
      lastSeen: Date.now(),
      mixer: null,
      actions: {},
      currentState: 'idle',
      estimatedSpeed: 0,
      lastPosition: new THREE.Vector3(),
      lastUpdateAt: Date.now(),
      color: desiredColor,
      name: desiredName,
      chatBubble: this._attachChatBubble(object3D),
      nameTag: this._attachNameTag(object3D),
      labelAnchorY: this._estimateLabelAnchorY(object3D),
      usesFallback
    };
    object3D.userData.labelAnchorY = remote.labelAnchorY;
    this._resetChatBubble(remote.chatBubble);
    this._setNameTagText(remote.nameTag, remote.name);

    if (!usesFallback) {
      this._initRemoteAnimationRig(remote);
      this._setRemotePlayerColor(remote, desiredColor);
    }

    return remote;
  }

  _initRemoteAnimationRig(remote) {
    if (!remote || !remote.object3D || remote.usesFallback) {
      return;
    }

    const visual = remote.object3D.children[0] || null;
    if (!visual) {
      return;
    }

    const mixer = new THREE.AnimationMixer(visual);
    const actions = {};

    for (const stateName of this.remoteStateOrder) {
      const clip = this.remoteClipMap[stateName];
      if (!clip) {
        continue;
      }

      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      actions[stateName] = action;
    }

    remote.mixer = mixer;
    remote.actions = actions;
    remote.currentState = actions.idle ? 'idle' : (actions.walk ? 'walk' : (actions.run ? 'run' : 'idle'));

    const initialAction = actions[remote.currentState] || Object.values(actions)[0] || null;
    if (initialAction) {
      initialAction.reset().play();
    }
  }

  _setRemotePlayerColor(remote, colorHex) {
    if (!remote || !remote.object3D) {
      return;
    }

    const safe = normalizeHexColor(colorHex);
    remote.color = safe;

    if (remote.usesFallback) {
      const mesh = remote.object3D.children[0];
      if (mesh?.material?.color) {
        mesh.material.color.set(safe);
      }
      return;
    }

    const visual = remote.object3D.children[0];
    if (visual) {
      this._applyColorToVisual(visual, safe);
    }
  }

  _estimateLabelAnchorY(ownerObject3D) {
    if (!ownerObject3D) {
      return 3.6;
    }

    const visual = ownerObject3D.children?.[0] || ownerObject3D;
    this.tempBounds.setFromObject(visual);
    this.tempBounds.getSize(this.tempBoundsSize);

    const height = Number.isFinite(this.tempBoundsSize.y) && this.tempBoundsSize.y > 0.1
      ? this.tempBoundsSize.y
      : 2.2;

    return clamp(height + 0.9, 2.8, 6.8);
  }

  _setRemoteState(remote, nextState) {
    if (!remote || !remote.actions) {
      return;
    }

    const playable = remote.actions[nextState]
      ? nextState
      : (remote.actions.walk ? 'walk' : (remote.actions.idle ? 'idle' : (remote.actions.run ? 'run' : null)));

    if (!playable || playable === remote.currentState) {
      return;
    }

    const fromAction = remote.actions[remote.currentState] || null;
    const toAction = remote.actions[playable] || null;
    if (!toAction) {
      return;
    }

    const fade = 0.16;
    if (fromAction) {
      fromAction.fadeOut(fade);
    }

    toAction.reset().setEffectiveWeight(1).fadeIn(fade).play();
    remote.currentState = playable;
  }

  _updateRemoteAnimation(remote, deltaSeconds) {
    if (!remote || !remote.mixer || !remote.actions) {
      return;
    }

    let nextState = 'idle';
    if ((remote.estimatedSpeed || 0) > 5.2) {
      nextState = 'run';
    } else if ((remote.estimatedSpeed || 0) > 0.3) {
      nextState = 'walk';
    }

    this._setRemoteState(remote, nextState);

    const action = remote.actions[remote.currentState];
    if (action) {
      if (remote.currentState === 'walk') {
        action.setEffectiveTimeScale(clamp((remote.estimatedSpeed || 0) / this.walkReferenceSpeed, 0.7, 1.35));
      } else if (remote.currentState === 'run') {
        action.setEffectiveTimeScale(clamp((remote.estimatedSpeed || 0) / this.runReferenceSpeed, 0.7, 1.35));
      } else {
        action.setEffectiveTimeScale(1);
      }
    }

    remote.mixer.update(deltaSeconds);
  }

  _upgradeRemotePlayersToModel() {
    if (!this.remoteTemplateReady || this.remotePlayers.size === 0) {
      return;
    }

    for (const [playerId, remote] of this.remotePlayers.entries()) {
      if (!remote.usesFallback) {
        continue;
      }

      const snapshot = {
        position: {
          x: remote.object3D.position.x,
          y: remote.object3D.position.y,
          z: remote.object3D.position.z
        },
        rotationY: remote.object3D.rotation.y,
        color: remote.color,
        name: remote.name
      };

      this.scene.remove(remote.object3D);
      this.remotePool.release(remote.object3D);

      const upgraded = this._createRemotePlayerInstance(playerId, snapshot);
      upgraded.targetPosition.copy(remote.targetPosition);
      upgraded.targetRotationY = remote.targetRotationY;
      upgraded.lastSeen = remote.lastSeen;
      upgraded.estimatedSpeed = remote.estimatedSpeed || 0;
      if (remote.chatBubble) {
        upgraded.chatBubble.message = remote.chatBubble.message || '';
        upgraded.chatBubble.typing = remote.chatBubble.typing === true;
        upgraded.chatBubble.expiresAt = Number(remote.chatBubble.expiresAt) || 0;
        if (upgraded.chatBubble.typing) {
          this._drawChatBubble(upgraded.chatBubble, '...');
          upgraded.chatBubble.sprite.visible = true;
        } else if (upgraded.chatBubble.message && upgraded.chatBubble.expiresAt > Date.now()) {
          this._drawChatBubble(upgraded.chatBubble, upgraded.chatBubble.message);
          upgraded.chatBubble.sprite.visible = true;
        }
      }
      upgraded.object3D.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      upgraded.object3D.rotation.y = snapshot.rotationY;
      upgraded.lastPosition.copy(upgraded.object3D.position);
      upgraded.labelAnchorY = this._estimateLabelAnchorY(upgraded.object3D);
      upgraded.object3D.userData.labelAnchorY = upgraded.labelAnchorY;
      this.scene.add(upgraded.object3D);
      this.remotePlayers.set(playerId, upgraded);
    }
  }

  _setupAnimations(clips) {
    if (!this.localVisual || !Array.isArray(clips) || clips.length === 0) {
      return;
    }

    this.mixer = new THREE.AnimationMixer(this.localVisual);
    this.actions = {};

    const clipMap = this._resolveAnimationClips(clips);

    for (const stateName of PLAYABLE_STATES) {
      const sourceClip = clipMap[stateName];
      if (!sourceClip) {
        continue;
      }

      const preprocessed = this._preprocessClip(sourceClip, stateName);
      if (!preprocessed) {
        continue;
      }

      const action = this.mixer.clipAction(preprocessed);
      if (stateName === 'jump') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      this.actions[stateName] = action;
    }

    this.jumpLockActive = false;
    this.groundedFrameStreak = 0;
    this.previousOnGround = null;
    this.stableGroundFrames = 0;
    this.hasStableGroundContact = false;

    const initialState = this._resolvePlayableState('idle');
    this.currentState = initialState;
    this.previousState = initialState;
    this.currentAction = this.actions[initialState] || Object.values(this.actions)[0] || null;

    if (this.currentAction) {
      this.currentAction.reset().play();
      const clipLabel = this.currentAction.getClip()?.name?.toLowerCase() || '';
      if (clipLabel.includes('run')) this.currentState = 'run';
      else if (clipLabel.includes('walk')) this.currentState = 'walk';
      else if (clipLabel.includes('jump')) this.currentState = 'jump';
      else this.currentState = 'idle';
    }

    if (this.debugAnimations) {
      const selected = Object.fromEntries(
        Object.entries(clipMap).map(([state, clip]) => [state, clip ? clip.name : '(missing)'])
      );
      const missingStates = PLAYABLE_STATES.filter((state) => !this.actions[state]);
      const currentClip = this.currentAction ? this.currentAction.getClip()?.name : '(none)';
      console.info(
        '[Anim] clips=%o missing=%o current=%s state=%s facingOffset=%.3f alignmentPending=%s',
        selected,
        missingStates,
        currentClip,
        this.currentState,
        this.modelFacingOffset,
        this.alignmentPending
      );
    }
  }

  _resolveAnimationClips(clips) {
    const candidates = {
      idle: [],
      walk: [],
      run: [],
      jump: []
    };

    for (const clip of clips) {
      if (!this._isUsableClip(clip)) {
        continue;
      }

      const { full, base } = this._normalizeClipName(clip.name);

      if (base === 'idle' || base.startsWith('idle')) {
        candidates.idle.push({ clip, full });
      }

      if (base === 'walk' || base === 'walking' || base.startsWith('walk')) {
        candidates.walk.push({ clip, full });
      }

      if (base === 'run' || base === 'running' || base.startsWith('run')) {
        candidates.run.push({ clip, full });
      }

      if (
        (base === 'jump' || /^jump(\.|_|$)/.test(base))
        && !base.startsWith('jump_start')
        && !base.startsWith('jump_air')
        && !base.startsWith('jump_land')
      ) {
        candidates.jump.push({ clip, full });
      }
    }

    const pick = (stateName) => {
      const list = candidates[stateName];
      if (!list || list.length === 0) {
        return null;
      }

      const exactState = list.find((entry) => entry.full === stateName);
      if (exactState) {
        return exactState.clip;
      }

      // Prefer walk.002 when multiple walk clips exist (e.g. walk.001, walk.002).
      if (stateName === 'walk') {
        const preferredWalk = list.find((entry) => entry.full === 'walk.002' || entry.full === 'walk_002');
        if (preferredWalk) {
          return preferredWalk.clip;
        }
      }

      return list[0].clip;
    };

    return {
      idle: pick('idle'),
      walk: pick('walk'),
      run: pick('run'),
      jump: pick('jump')
    };
  }

  _normalizeClipName(name) {
    const lowered = (name || '').toLowerCase().trim();
    const segment = lowered.includes('|') ? lowered.split('|').pop().trim() : lowered;
    const full = segment.replace(/\s+/g, '_').replace(/-/g, '_');
    const base = full.replace(/\.\d+$/g, '').replace(/_\d+$/g, '');
    return { full, base };
  }

  _preprocessClip(sourceClip, stateName) {
    const filteredTracks = sourceClip.tracks
      .filter((track) => !this._shouldStripRootTransformTrack(track.name))
      .map((track) => (typeof track.clone === 'function' ? track.clone() : track));

    if (filteredTracks.length === 0) {
      return null;
    }

    const clip = new THREE.AnimationClip(
      `${stateName}::${sourceClip.name}`,
      sourceClip.duration,
      filteredTracks
    );
    clip.resetDuration();
    return this._isUsableClip(clip) ? clip : null;
  }

  _shouldStripRootTransformTrack(trackName) {
    const name = String(trackName || '').toLowerCase();
    const isTransformTrack = (
      name === 'position'
      || name === 'scale'
      || name.endsWith('.position')
      || name.endsWith('.scale')
    );
    if (!isTransformTrack) {
      return false;
    }

    if (name === 'position' || name === 'scale') {
      return true;
    }

    const dot = name.lastIndexOf('.');
    if (dot === -1) {
      return false;
    }

    const target = name.slice(0, dot);
    return (
      target === 'armature'
      || target.startsWith('armature.')
      || target === 'root'
      || target === 'scene'
      || target === 'char_model_n3d'
      || target.startsWith('char_model')
    );
  }

  _isUsableClip(clip) {
    if (!clip) {
      return false;
    }

    if (!Number.isFinite(clip.duration) || clip.duration <= 0.0001) {
      return false;
    }

    return Array.isArray(clip.tracks) && clip.tracks.length > 0;
  }

  _buildAnimationInput(movementState) {
    const velocity = movementState.velocity || { x: 0, z: 0 };
    const vx = Number.isFinite(velocity.x) ? velocity.x : 0;
    const vz = Number.isFinite(velocity.z) ? velocity.z : 0;
    const speed = Number.isFinite(movementState.speed)
      ? movementState.speed
      : Math.sqrt((vx * vx) + (vz * vz));

    const moving = movementState.moving === true || speed > 0.3;

    return {
      moving,
      sprintingForward: movementState.sprintingForward === true,
      onGround: movementState.onGround === true,
      justJumped: movementState.justJumped === true,
      verticalVelocity: Number.isFinite(movementState.verticalVelocity) ? movementState.verticalVelocity : 0,
      speed,
      vx,
      vz
    };
  }

  _updateJumpLock(input) {
    if (input.onGround) {
      this.stableGroundFrames = Math.min(this.stableGroundFrames + 1, 16);
      if (this.stableGroundFrames >= 2) {
        this.hasStableGroundContact = true;
      }
    } else {
      this.stableGroundFrames = 0;
    }

    if (input.justJumped) {
      this.jumpLockActive = true;
      this.groundedFrameStreak = 0;
    }

    if (this.jumpLockActive) {
      if (input.onGround) {
        this.groundedFrameStreak += 1;
        if (this.groundedFrameStreak >= 2) {
          this.jumpLockActive = false;
          this.groundedFrameStreak = 0;
        }
      } else {
        this.groundedFrameStreak = 0;
      }
    }

    this.previousOnGround = input.onGround;
  }

  _autoAlignFacing(input) {
    if (!this.localVisual || !this.localPlayer || !this.alignmentPending) {
      return;
    }

    if (!input.onGround || input.speed < this.alignmentMinSpeed) {
      this._resetFacingAlignmentSampling();
      return;
    }

    const visualYaw = this._readVisualForwardYaw();
    if (!Number.isFinite(visualYaw)) {
      this._resetFacingAlignmentSampling();
      return;
    }

    const velocityYaw = Math.atan2(input.vx, input.vz);
    const delta = normalizeAngle(velocityYaw - visualYaw);
    const candidateOffset = normalizeAngle(this.modelFacingOffset + delta);

    this.alignmentStableFrames += 1;
    this.alignmentSampleCount += 1;
    this.alignmentOffsetSinSum += Math.sin(candidateOffset);
    this.alignmentOffsetCosSum += Math.cos(candidateOffset);

    if (
      this.alignmentStableFrames < this.alignmentStableFramesRequired
      || this.alignmentSampleCount < this.alignmentSamplesRequired
    ) {
      return;
    }

    const averagedOffset = Math.atan2(this.alignmentOffsetSinSum, this.alignmentOffsetCosSum);
    this.modelFacingOffset = quantizeQuarterTurn(averagedOffset);
    this.alignmentPending = false;
    this.facingCalibrated = true;
    this._resetFacingAlignmentSampling();

    if (this.debugAnimations) {
      console.info('[Anim] facing aligned offset=%.3f', this.modelFacingOffset);
    }
  }

  _updateMovementRotation(input, deltaSeconds, drawMode) {
    if (drawMode || !this.localPlayer) {
      return;
    }

    const speedSq = (input.vx * input.vx) + (input.vz * input.vz);
    if (speedSq <= this.minMoveRotateSpeedSq) {
      return;
    }

    this.targetRotation = Math.atan2(input.vx, input.vz) + this.modelFacingOffset;
    this.localPlayer.rotation.y = dampAngle(this.localPlayer.rotation.y, this.targetRotation, 14, deltaSeconds);
  }

  _resolveAnimationState(input) {
    if (this.currentState === 'jump') {
      this.jumpLockActive = false;
      this.groundedFrameStreak = 0;
    }

    if (input.sprintingForward) {
      return 'run';
    }

    if (input.moving) {
      return 'walk';
    }

    return 'idle';
  }

  _resolvePlayableState(state) {
    if (this.actions[state]) {
      return state;
    }

    if (state === 'run' && this.actions.walk) return 'walk';
    if (state === 'walk' && this.actions.idle) return 'idle';
    if (state === 'jump' && this.actions.idle) return 'idle';

    if (this.actions.idle) return 'idle';
    if (this.actions.walk) return 'walk';
    if (this.actions.run) return 'run';
    if (this.actions.jump) return 'jump';

    return this.currentState;
  }

  _transitionToState(nextState, input) {
    const playable = this._resolvePlayableState(nextState);
    if (!playable || playable === this.currentState) {
      return;
    }

    const fadeDuration = this._getFadeDuration(this.currentState, playable);
    const shouldReset = playable === 'jump';
    const fromState = this.currentState;

    this.previousState = this.currentState;
    this.currentState = playable;
    this._playAction(playable, fadeDuration, shouldReset);

    if (this.debugAnimations) {
      console.info(
        '[Anim] %s -> %s | speed=%.2f moving=%s sprintingForward=%s onGround=%s justJumped=%s jumpLock=%s',
        fromState,
        playable,
        input.speed,
        input.moving,
        input.sprintingForward,
        input.onGround,
        input.justJumped,
        this.jumpLockActive
      );
    }
  }

  _syncLocomotionTimescale(input) {
    if (!this.currentAction) {
      return;
    }

    if (this.currentState === 'jump') {
      const jumpClip = this.currentAction.getClip?.();
      const jumpDuration = Number.isFinite(jumpClip?.duration) ? jumpClip.duration : 0;
      if (jumpDuration > 0.001) {
        const takeoffTime = jumpDuration * (this.jumpFrameTakeoff / 45);
        const apexTime = jumpDuration * (this.jumpFrameApex / 45);
        const landTime = jumpDuration * (this.jumpFrameLand / 45);
        const recoverTime = jumpDuration * (this.jumpFrameRecover / 45);

        if (!input.onGround) {
          if (this.currentAction.time < takeoffTime) {
            this.currentAction.setEffectiveTimeScale(1.9);
            return;
          }

          if (this.currentAction.time < apexTime && input.verticalVelocity >= 0) {
            this.currentAction.setEffectiveTimeScale(1.2);
            return;
          }

          if (this.currentAction.time < landTime) {
            this.currentAction.setEffectiveTimeScale(0.95);
            return;
          }

          this.currentAction.setEffectiveTimeScale(0.9);
          return;
        }

        if (this.currentAction.time < landTime) {
          this.currentAction.setEffectiveTimeScale(1.6);
          return;
        }

        if (this.currentAction.time < recoverTime) {
          this.currentAction.setEffectiveTimeScale(1.05);
          return;
        }
      }

      this.currentAction.setEffectiveTimeScale(1);
      return;
    }

    if (this.currentState === 'walk') {
      const scale = clamp(input.speed / this.walkReferenceSpeed, 0.7, 1.3);
      this.currentAction.setEffectiveTimeScale(scale);
      return;
    }

    if (this.currentState === 'run') {
      const scale = clamp(input.speed / this.runReferenceSpeed, 0.7, 1.3);
      this.currentAction.setEffectiveTimeScale(scale);
      return;
    }

    this.currentAction.setEffectiveTimeScale(1);
  }

  _getFadeDuration(fromState, toState) {
    if (fromState === 'jump' || toState === 'jump') {
      return 0.1;
    }
    return 0.16;
  }

  _playAction(name, fadeDuration, shouldReset = true) {
    const action = this.actions[name];
    if (!action) {
      return;
    }

    if (this.currentAction === action) {
      return;
    }

    if (this.currentAction) {
      this.currentAction.fadeOut(fadeDuration);
    }

    this.currentAction = action;

    if (shouldReset || !this.currentAction.isRunning()) {
      this.currentAction.reset();
    }

    this.currentAction
      .setEffectiveWeight(1)
      .fadeIn(fadeDuration)
      .play();
  }

  _findFacingReferenceNode() {
    if (!this.localVisual) {
      return null;
    }

    let hips = null;
    let pelvis = null;
    let rootBone = null;

    this.localVisual.traverse((node) => {
      if (!node.isBone) {
        return;
      }

      const name = (node.name || '').toLowerCase();
      if (!rootBone) {
        rootBone = node;
      }
      if (!hips && name.includes('hips')) {
        hips = node;
      }
      if (!pelvis && name.includes('pelvis')) {
        pelvis = node;
      }
    });

    return hips || pelvis || rootBone || this.localVisual;
  }

  _readVisualForwardYaw() {
    if (!this.localVisual) {
      return null;
    }

    const reference = this.facingReferenceNode || this._findFacingReferenceNode();
    if (!reference) {
      return null;
    }

    this.localPlayer.updateMatrixWorld(true);
    reference.getWorldQuaternion(this.tempQuat);

    this.tempForward.set(0, 0, 1).applyQuaternion(this.tempQuat);
    this.tempForward.y = 0;
    const forwardLengthSq = this.tempForward.lengthSq();
    if (forwardLengthSq < 0.00001) {
      return null;
    }

    this.tempForward.multiplyScalar(1 / Math.sqrt(forwardLengthSq));
    return Math.atan2(this.tempForward.x, this.tempForward.z);
  }

  _resetFacingAlignmentSampling() {
    this.alignmentStableFrames = 0;
    this.alignmentSampleCount = 0;
    this.alignmentOffsetSinSum = 0;
    this.alignmentOffsetCosSum = 0;
  }

  _isolateVisualMaterials(root) {
    if (!root) {
      return;
    }

    root.traverse((node) => {
      if (!node?.isMesh || !node.material) {
        return;
      }

      if (Array.isArray(node.material)) {
        node.material = node.material.map((material) => (material?.clone ? material.clone() : material));
      } else if (node.material?.clone) {
        node.material = node.material.clone();
      }
    });
  }

  _applyColorToVisual(root, colorHex) {
    const safe = normalizeHexColor(colorHex);
    const accent = lightenHexColor(safe, 0.38);
    let meshIndex = 0;

    root.traverse((node) => {
      if (!node?.isMesh || !node.material) {
        return;
      }

      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material?.color) {
          continue;
        }

        material.color.set(meshIndex === 0 ? safe : accent);
        meshIndex += 1;
      }
    });
  }

  _attachChatBubble(ownerObject3D) {
    if (!ownerObject3D) {
      return null;
    }

    if (ownerObject3D.userData?.chatBubble) {
      return ownerObject3D.userData.chatBubble;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.set(0, 4.6, 0);
    sprite.scale.set(6.2, 2.45, 1);
    sprite.renderOrder = 3000;
    sprite.visible = false;
    ownerObject3D.add(sprite);

    const bubble = {
      canvas,
      ctx,
      texture,
      sprite,
      message: '',
      typing: false,
      expiresAt: 0
    };

    this._drawChatBubble(bubble, '');
    ownerObject3D.userData.chatBubble = bubble;
    return bubble;
  }

  _attachNameTag(ownerObject3D) {
    if (!ownerObject3D) {
      return null;
    }

    if (ownerObject3D.userData?.nameTag) {
      return ownerObject3D.userData.nameTag;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.set(0, 3.9, 0);
    sprite.scale.set(4.4, 1.1, 1);
    sprite.renderOrder = 2900;
    ownerObject3D.add(sprite);

    const tag = { canvas, ctx, texture, sprite, text: DEFAULT_PLAYER_NAME };
    ownerObject3D.userData.nameTag = tag;
    this._setNameTagText(tag, DEFAULT_PLAYER_NAME);
    return tag;
  }

  _setNameTagText(tag, text) {
    if (!tag?.ctx) {
      return;
    }

    const safe = sanitizePlayerName(text);
    tag.text = safe;

    const { ctx, canvas, texture } = tag;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pad = 10;
    const w = canvas.width - (pad * 2);
    const h = canvas.height - (pad * 2);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.76)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.36)';
    ctx.lineWidth = 2;
    const radius = 12;
    ctx.beginPath();
    ctx.moveTo(pad + radius, pad);
    ctx.lineTo(pad + w - radius, pad);
    ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + radius);
    ctx.lineTo(pad + w, pad + h - radius);
    ctx.quadraticCurveTo(pad + w, pad + h, pad + w - radius, pad + h);
    ctx.lineTo(pad + radius, pad + h);
    ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - radius);
    ctx.lineTo(pad, pad + radius);
    ctx.quadraticCurveTo(pad, pad, pad + radius, pad);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 30px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(safe, canvas.width * 0.5, canvas.height * 0.54);

    texture.needsUpdate = true;
    tag.sprite.visible = true;
  }

  _drawChatBubble(bubble, text) {
    if (!bubble?.ctx) {
      return;
    }

    const { ctx, canvas, texture } = bubble;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const content = String(text || '').trim();
    if (!content) {
      texture.needsUpdate = true;
      return;
    }

    const pad = 12;
    const w = canvas.width - (pad * 2);
    const h = canvas.height - 32;
    const r = 20;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.strokeStyle = 'rgba(8, 8, 8, 0.92)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.lineTo(pad + w - r, pad);
    ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
    ctx.lineTo(pad + w, pad + h - r);
    ctx.quadraticCurveTo(pad + w, pad + h, pad + w - r, pad + h);
    ctx.lineTo((canvas.width * 0.5) + 26, pad + h);
    ctx.lineTo(canvas.width * 0.5, canvas.height - 6);
    ctx.lineTo((canvas.width * 0.5) - 26, pad + h);
    ctx.lineTo(pad + r, pad + h);
    ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - r);
    ctx.lineTo(pad, pad + r);
    ctx.quadraticCurveTo(pad, pad, pad + r, pad);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0a0a0a';
    ctx.font = '700 34px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const clampedText = content.slice(0, CHAT_BUBBLE_MAX_CHARS);
    const words = clampedText.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width < (w - 40)) {
        line = candidate;
      } else {
        if (line) {
          lines.push(line);
        }
        line = word;
      }
      if (lines.length >= 2) {
        break;
      }
    }
    if (line && lines.length < 2) {
      lines.push(line);
    }
    if (lines.length === 0) {
      lines.push(clampedText);
    }

    const lineHeight = 38;
    const startY = (canvas.height * 0.5) - ((lines.length - 1) * lineHeight * 0.5) - 10;
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], canvas.width * 0.5, startY + (i * lineHeight));
    }

    texture.needsUpdate = true;
  }

  _setChatBubbleMessage(bubble, message, durationMs) {
    if (!bubble) {
      return;
    }

    const sanitized = String(message || '').trim().slice(0, CHAT_BUBBLE_MAX_CHARS);
    if (!sanitized) {
      return;
    }

    bubble.message = sanitized;
    bubble.typing = false;
    bubble.expiresAt = Date.now() + Math.max(800, Number(durationMs) || CHAT_BUBBLE_DURATION_MS);
    this._drawChatBubble(bubble, bubble.message);
    bubble.sprite.visible = true;
  }

  _resetChatBubble(bubble) {
    if (!bubble) {
      return;
    }
    bubble.message = '';
    bubble.typing = false;
    bubble.expiresAt = 0;
    bubble.sprite.visible = false;
    this._drawChatBubble(bubble, '');
  }

  _setChatBubbleTyping(bubble, typing) {
    if (!bubble) {
      return;
    }

    bubble.typing = typing === true;
    if (bubble.typing) {
      this._drawChatBubble(bubble, '...');
      bubble.sprite.visible = true;
      return;
    }

    if (bubble.message && bubble.expiresAt > Date.now()) {
      this._drawChatBubble(bubble, bubble.message);
      bubble.sprite.visible = true;
      return;
    }

    bubble.sprite.visible = false;
  }

  _updateChatBubble(bubble, nowMs) {
    if (!bubble) {
      return;
    }

    if (bubble.typing) {
      bubble.sprite.visible = true;
      return;
    }

    if (bubble.message && bubble.expiresAt > nowMs) {
      bubble.sprite.visible = true;
      return;
    }

    bubble.sprite.visible = false;
  }

  _updateLabelAnchors() {
    const applyAnchor = (ownerObject3D, nameTag, chatBubble, cachedAnchor = null) => {
      if (!ownerObject3D) {
        return;
      }

      const anchor = Number.isFinite(cachedAnchor)
        ? cachedAnchor
        : (Number(ownerObject3D.userData?.labelAnchorY) || this._estimateLabelAnchorY(ownerObject3D));
      ownerObject3D.userData.labelAnchorY = anchor;

      if (nameTag?.sprite) {
        nameTag.sprite.position.y = anchor + 0.18;
      }
      if (chatBubble?.sprite) {
        chatBubble.sprite.position.y = anchor + 1.05;
      }
    };

    applyAnchor(this.localPlayer, this.localNameTag, this.localChatBubble, this.localPlayer?.userData?.labelAnchorY);
    for (const remote of this.remotePlayers.values()) {
      applyAnchor(remote.object3D, remote.nameTag, remote.chatBubble, remote.labelAnchorY);
    }
  }
}
