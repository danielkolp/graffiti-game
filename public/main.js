import * as THREE from './vendor/three/build/three.module.js';
import { RendererSystem } from './core/Renderer.js';
import { SceneManager } from './core/SceneManager.js';
import { CameraController } from './core/CameraController.js';
import { PlayerController } from './game/PlayerController.js';
import { MovementSystem } from './game/MovementSystem.js';
import { DrawingSystem } from './game/DrawingSystem.js';
import { SocketManager } from './network/SocketManager.js';
import { SyncSystem } from './network/SyncSystem.js';
import { UIManager } from './ui/UIManager.js';

function getRuntimeConfig() {
  const globalConfig = globalThis.__GRAFFITI_CONFIG || {};
  const params = new URLSearchParams(globalThis.location.search);

  const apiBaseUrl = (params.get('api') || globalConfig.apiBaseUrl || '').trim() || null;
  const socketUrl = (params.get('socket') || globalConfig.socketUrl || apiBaseUrl || '').trim() || null;

  return {
    apiBaseUrl,
    socketUrl
  };
}

class GameApp {
  constructor() {
    this.ui = new UIManager();
    this.clock = new THREE.Clock();
    this.fpsSmoothed = 60;
    this.started = false;
    this.debugTelemetryEnabled = false;
    this.debugLongFrameThresholdMs = 120;
    this.debugFrameRingSize = 180;
    this.debugFrames = [];
    this.debugFrameCursor = 0;
    this.debugRollingLongFrames = 0;
    this.debugHitchDeltaThresholdMs = 220;
    this.debugHitchFrameThresholdMs = 160;
    this.debugHitchRingSize = 60;
    this.debugHitchEvents = [];
    this.debugHitchCursor = 0;
    this.lastMovementState = this._createEmptyMovementState();

    this.rendererSystem = null;
    this.sceneManager = null;
    this.camera = null;
    this.cameraController = null;
    this.playerController = null;
    this.movementSystem = null;
    this.drawingSystem = null;
    this.socketManager = null;
    this.syncSystem = null;
    this.runtimeConfig = getRuntimeConfig();

    this.boundTick = this._tick.bind(this);
    this._bindStartOverlay();
    this._bindDebugToggle();
    this._exposeDebugApi();
  }

  async init() {
    this.ui.setLoadingProgress(0.01, 'Bootstrapping');
    this.ui.setDebugExpanded(false);

    this.rendererSystem = new RendererSystem({
      enableBloom: false,
      maxPixelRatio: 1.25
    });
    this.rendererSystem.attachTo(document.body);

    this.sceneManager = new SceneManager((progress, label) => {
      this.ui.setLoadingProgress(progress * 0.75, label);
    });

    await this.sceneManager.initialize();
    this.sceneManager.update(0, this.rendererSystem.renderer);

    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
    this.camera.position.set(0, 4.8, 9.5);

    this.rendererSystem.setSceneAndCamera(this.sceneManager.getScene(), this.camera);

    this.playerController = new PlayerController(this.sceneManager.getScene(), this.sceneManager.loadingManager);
    await this.playerController.loadLocalPlayer();
    this.ui.setLoadingProgress(0.86, 'Preparing player');

    this.cameraController = new CameraController(this.camera);
    this.cameraController.setTarget(this.playerController.getLocalPlayer());
    this.cameraController.bindInput(this.rendererSystem.getDomElement());

    this.movementSystem = new MovementSystem(this.sceneManager.getWorldOctree());

    this.drawingSystem = new DrawingSystem(
      this.sceneManager.getScene(),
      this.camera,
      this.rendererSystem,
      this.ui
    );
    this.drawingSystem.setCollidableMeshes(this.sceneManager.getCollidableMeshes());
    this.drawingSystem.setPlayerObject(this.playerController.getLocalPlayer());

    this.socketManager = new SocketManager({
      socketUrl: this.runtimeConfig.socketUrl
    });
    this.syncSystem = new SyncSystem(
      this.socketManager,
      this.playerController,
      this.drawingSystem,
      this.ui,
      {
        apiBaseUrl: this.runtimeConfig.apiBaseUrl
      }
    );

    this.syncSystem.connect();
    this.syncSystem.bootstrap().catch((error) => {
      console.warn('Background state bootstrap failed:', error);
    });

    this.ui.setLoadingProgress(1, 'Ready');
    setTimeout(() => this.ui.hideLoading(), 180);
    if (globalThis.__graffitiBoot) {
      globalThis.__graffitiBoot.started = true;
    }

    this._bindResize();
    this.clock.start();
    requestAnimationFrame(this.boundTick);
  }

  _bindStartOverlay() {
    this.ui.bindStart(() => {
      this.started = true;
    });
  }

  _bindDebugToggle() {
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'F3' || event.repeat) {
        return;
      }

      event.preventDefault();
      this.setDiagnosticsEnabled(!this.debugTelemetryEnabled);
    });
  }

  _exposeDebugApi() {
    globalThis.__graffitiDebug = {
      enable: () => this.setDiagnosticsEnabled(true),
      disable: () => this.setDiagnosticsEnabled(false),
      toggle: () => this.setDiagnosticsEnabled(!this.debugTelemetryEnabled),
      dump: () => this._dumpDebugFrames(),
      dumpHitches: () => this._dumpHitchEvents(),
      getState: () => ({
        enabled: this.debugTelemetryEnabled,
        longFrames: this.debugRollingLongFrames,
        thresholdMs: this.debugLongFrameThresholdMs,
        frames: this._getOrderedDebugFrames(),
        hitchThresholds: {
          frameMs: this.debugHitchFrameThresholdMs,
          rawDeltaMs: this.debugHitchDeltaThresholdMs
        },
        hitches: this._getOrderedHitchEvents()
      })
    };
  }

  _createEmptyMovementState() {
    return {
      inputActive: false,
      rotateToInput: false,
      inputYaw: null,
      inputAxes: { forward: 0, strafe: 0, mouseForward: false },
      speed: 0,
      onGround: false
    };
  }

  setDiagnosticsEnabled(enabled) {
    const next = enabled === true;
    if (this.debugTelemetryEnabled === next) {
      return;
    }

    this.debugTelemetryEnabled = next;
    this.debugFrames = [];
    this.debugFrameCursor = 0;
    this.debugRollingLongFrames = 0;
    this.debugHitchEvents = [];
    this.debugHitchCursor = 0;
    this.ui.setDebugExpanded(next);
    console.info('[Debug] diagnostics %s', next ? 'enabled' : 'disabled');
  }

  _dumpDebugFrames() {
    const ordered = this._getOrderedDebugFrames();
    console.groupCollapsed('[Debug] frame history (%d entries)', ordered.length);
    for (const frame of ordered) {
      console.log(frame);
    }
    console.groupEnd();
    return ordered;
  }

  _dumpHitchEvents() {
    const ordered = this._getOrderedHitchEvents();
    console.groupCollapsed('[Debug] hitch events (%d entries)', ordered.length);
    for (const hitch of ordered) {
      console.log(hitch);
    }
    console.groupEnd();
    return ordered;
  }

  _getOrderedDebugFrames() {
    if (this.debugFrames.length < this.debugFrameRingSize || this.debugFrameCursor === 0) {
      return [...this.debugFrames];
    }

    return [
      ...this.debugFrames.slice(this.debugFrameCursor),
      ...this.debugFrames.slice(0, this.debugFrameCursor)
    ];
  }

  _getOrderedHitchEvents() {
    if (this.debugHitchEvents.length < this.debugHitchRingSize || this.debugHitchCursor === 0) {
      return [...this.debugHitchEvents];
    }

    return [
      ...this.debugHitchEvents.slice(this.debugHitchCursor),
      ...this.debugHitchEvents.slice(0, this.debugHitchCursor)
    ];
  }

  _recordDebugFrame(snapshot) {
    if (!this.debugTelemetryEnabled) {
      return;
    }

    if (this.debugFrames.length < this.debugFrameRingSize) {
      this.debugFrames.push(snapshot);
    } else {
      this.debugFrames[this.debugFrameCursor] = snapshot;
      this.debugFrameCursor = (this.debugFrameCursor + 1) % this.debugFrameRingSize;
    }

    this.debugRollingLongFrames = this.debugFrames.reduce(
      (count, frame) => count + (frame.longFrame === true ? 1 : 0),
      0
    );
  }

  _recordHitchEvent(snapshot) {
    if (snapshot?.hitch !== true) {
      return;
    }

    if (this.debugHitchEvents.length < this.debugHitchRingSize) {
      this.debugHitchEvents.push(snapshot);
    } else {
      this.debugHitchEvents[this.debugHitchCursor] = snapshot;
      this.debugHitchCursor = (this.debugHitchCursor + 1) % this.debugHitchRingSize;
    }
  }

  _bindResize() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.rendererSystem.resize(window.innerWidth, window.innerHeight);
    });
  }

  _tick() {
    const frameStart = performance.now();
    const rawDelta = this.clock.getDelta();
    const delta = Math.min(rawDelta, 0.05);
    const timings = {
      movement: 0,
      player: 0,
      camera: 0,
      drawing: 0,
      sync: 0,
      render: 0,
      total: 0
    };

    let movementState = this.lastMovementState;

    if (this.started) {
      const drawMode = this.drawingSystem.isDrawModeActive();
      this.movementSystem.setEnabled(!drawMode);
      this.cameraController.setEnabled(!drawMode);

      const movementBasis = this.cameraController.getMovementBasis();
      const cameraControlState = this.cameraController.getControlState();

      let marker = performance.now();
      movementState = this.movementSystem.update(
        this.playerController.getLocalPlayer(),
        movementBasis,
        delta,
        cameraControlState
      );
      timings.movement = performance.now() - marker;

      marker = performance.now();
      this.playerController.update(delta, movementState, { drawMode });
      timings.player = performance.now() - marker;

      marker = performance.now();
      this.cameraController.setMovementState(movementState);
      this.cameraController.update(delta);
      timings.camera = performance.now() - marker;

      marker = performance.now();
      this.drawingSystem.update(delta);
      timings.drawing = performance.now() - marker;

      marker = performance.now();
      this.syncSystem.update(delta);
      timings.sync = performance.now() - marker;
    }

    const renderMarker = performance.now();
    this.rendererSystem.render(delta);
    timings.render = performance.now() - renderMarker;
    timings.total = performance.now() - frameStart;

    this.lastMovementState = movementState || this._createEmptyMovementState();
    const rawDeltaMs = rawDelta * 1000;
    const visibilityHidden = typeof document !== 'undefined' && document.hidden === true;
    const rawDeltaLooksLikeSchedulerStall = (
      rawDeltaMs > this.debugHitchDeltaThresholdMs
      && timings.total < this.debugHitchFrameThresholdMs * 0.5
      && (visibilityHidden || rawDeltaMs > 1000)
    );
    const hitch = timings.total > this.debugHitchFrameThresholdMs
      || (rawDeltaMs > this.debugHitchDeltaThresholdMs && !rawDeltaLooksLikeSchedulerStall);

    const frameSnapshot = {
      timestamp: Date.now(),
      rawDeltaMs,
      clampedDeltaMs: delta * 1000,
      timings,
      longFrame: timings.total > this.debugLongFrameThresholdMs,
      hitch,
      movement: {
        inputActive: this.lastMovementState.inputActive === true,
        rotateToInput: this.lastMovementState.rotateToInput === true,
        inputYaw: Number.isFinite(this.lastMovementState.inputYaw) ? this.lastMovementState.inputYaw : null,
        inputAxes: this.lastMovementState.inputAxes || { forward: 0, strafe: 0, mouseForward: false },
        speed: Number.isFinite(this.lastMovementState.speed) ? this.lastMovementState.speed : 0,
        onGround: this.lastMovementState.onGround === true,
        playerYaw: Number.isFinite(this.playerController?.getLocalPlayer()?.rotation?.y)
          ? this.playerController.getLocalPlayer().rotation.y
          : null
      }
    };

    this._recordDebugFrame(frameSnapshot);
    this._recordHitchEvent(frameSnapshot);

    if (hitch && (this.debugTelemetryEnabled || rawDeltaMs > 600)) {
      console.warn('[Debug] hitch raw=%.1fms frame=%.1fms', rawDeltaMs, timings.total);
    }

    this._updateDebug(rawDelta, timings, this.lastMovementState);

    requestAnimationFrame(this.boundTick);
  }

  _updateDebug(deltaSeconds, timings, movementState) {
    const fps = 1 / Math.max(deltaSeconds, 0.0001);
    this.fpsSmoothed = this.fpsSmoothed * 0.92 + fps * 0.08;

    const info = this.rendererSystem.getInfo();
    const memoryMB = performance.memory ? performance.memory.usedJSHeapSize / (1024 * 1024) : null;
    const playerYaw = Number.isFinite(this.playerController?.getLocalPlayer()?.rotation?.y)
      ? this.playerController.getLocalPlayer().rotation.y
      : null;

    this.ui.updateDebug({
      fps: this.fpsSmoothed,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      memoryMB,
      diagnosticsEnabled: this.debugTelemetryEnabled,
      frameMs: timings.total,
      longFrames: this.debugRollingLongFrames,
      longFrameThresholdMs: this.debugLongFrameThresholdMs,
      hitchCount: this.debugHitchEvents.length,
      timings,
      movement: {
        inputActive: movementState?.inputActive === true,
        rotateToInput: movementState?.rotateToInput === true,
        inputYaw: Number.isFinite(movementState?.inputYaw) ? movementState.inputYaw : null,
        inputAxes: movementState?.inputAxes || { forward: 0, strafe: 0, mouseForward: false },
        speed: Number.isFinite(movementState?.speed) ? movementState.speed : 0,
        onGround: movementState?.onGround === true,
        playerYaw
      }
    });
  }
}

const app = new GameApp();
app.init().catch((error) => {
  console.error('Fatal initialization error:', error);
  app.ui.showFatalError(
    'Initialization failed. Check console and run from http://127.0.0.1:3000/public/index.html'
  );
  if (globalThis.__graffitiBoot) {
    globalThis.__graffitiBoot.started = true;
  }
});
