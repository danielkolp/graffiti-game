import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { clamp, damp } from '../utils/math.js';

const PLAYABLE_STATES = ['idle', 'walk', 'run', 'jump'];
const QUARTER_TURN = Math.PI * 0.5;
const PLAYER_MODEL_CANDIDATES = [
  'models/idkbro.glb',
  './models/idkbro.glb',
  '../models/idkbro.glb',
  '../../models/idkbro.glb',
  '/models/idkbro.glb'
];
const PLAYER_LOAD_TIMEOUT_MS = 15000;

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
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

function buildFallbackCharacter() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.38, 1.05, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x1b69fa, roughness: 0.72, metalness: 0.08 })
  );
  body.castShadow = true;
  body.receiveShadow = false;
  body.position.y = 1.0;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0x9ec1ff, roughness: 0.8, metalness: 0.04 })
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

  acquire() {
    if (this.available.length > 0) {
      return this.available.pop();
    }

    const root = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 1.05, 8, 16),
      new THREE.MeshStandardMaterial({
        color: 0x5f8ad8,
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

    this.debugAnimations = isAnimationDebugEnabled();

    this.tempQuat = new THREE.Quaternion();
    this.tempForward = new THREE.Vector3();

    this.remotePlayers = new Map();
    this.remotePool = new RemotePlayerPool();
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
      timestamp: Date.now()
    };
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
          if (material.color) {
            material.color.setHex(0x1b69fa);
          }
          if (material.isMeshStandardMaterial) {
            material.roughness = 0.68;
            material.metalness = 0.08;
          }
        }
      });

      this.localPlayer.add(this.localVisual);
      this.facingReferenceNode = this._findFacingReferenceNode();
      this.facingCalibrated = false;
      this.alignmentPending = true;
      this._resetFacingAlignmentSampling();
      this._setupAnimations(gltf.animations || []);
    } catch (error) {
      console.error('Failed to load player model, using fallback:', error);
      this.localVisual = buildFallbackCharacter();
      this.localVisual.position.set(0, this.visualOffsetY, 0);
      this.localPlayer.add(this.localVisual);
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
  }

  upsertRemotePlayer(playerId, snapshot) {
    let remote = this.remotePlayers.get(playerId);

    if (!remote) {
      const object3D = this.remotePool.acquire();
      object3D.visible = true;
      this.scene.add(object3D);

      remote = {
        id: playerId,
        object3D,
        targetPosition: new THREE.Vector3(),
        targetRotationY: 0,
        lastSeen: Date.now()
      };
      this.remotePlayers.set(playerId, remote);
    }

    if (snapshot.position) {
      remote.targetPosition.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    }
    if (typeof snapshot.rotationY === 'number') {
      remote.targetRotationY = snapshot.rotationY;
    }
    remote.lastSeen = Date.now();
  }

  removeRemotePlayer(playerId) {
    const remote = this.remotePlayers.get(playerId);
    if (!remote) {
      return;
    }

    this.scene.remove(remote.object3D);
    this.remotePool.release(remote.object3D);
    this.remotePlayers.delete(playerId);
  }

  _updateRemotePlayers(deltaSeconds) {
    const now = Date.now();
    for (const [playerId, remote] of this.remotePlayers.entries()) {
      remote.object3D.position.lerp(remote.targetPosition, 1 - Math.exp(-12 * deltaSeconds));
      remote.object3D.rotation.y = damp(remote.object3D.rotation.y, remote.targetRotationY, 12, deltaSeconds);

      if (now - remote.lastSeen > 15000) {
        this.removeRemotePlayer(playerId);
      }
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
    } else if (this.hasStableGroundContact && this.previousOnGround === true && input.onGround === false) {
      // Entering air from a stable grounded frame (jump or ledge step).
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
    this.localPlayer.rotation.y = damp(this.localPlayer.rotation.y, this.targetRotation, 14, deltaSeconds);
  }

  _resolveAnimationState(input) {
    // If jump clip is clamped on its last frame and we've landed,
    // force a locomotion/idle state so we don't get stuck in jump pose.
    if (
      this.currentState === 'jump'
      && this.currentAction
      && this.currentAction.isRunning() === false
      && input.onGround
    ) {
      this.jumpLockActive = false;
      this.groundedFrameStreak = 0;
      if (input.sprintingForward) {
        return 'run';
      }
      if (input.moving) {
        return 'walk';
      }
      return 'idle';
    }

    if (input.justJumped || this.jumpLockActive) {
      return 'jump';
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
}
