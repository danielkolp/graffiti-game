export class UIManager {
  constructor() {
    this.root = document;

    this.loadingOverlay = this.root.getElementById('loading-overlay');
    this.loadingLabel = this.root.getElementById('loading-label');
    this.loadingBarFill = this.root.getElementById('loading-progress-fill');

    this.instructionsOverlay = this.root.getElementById('instructions-overlay');
    this.startButton = this.root.getElementById('start-game-button');

    this.connectionStatus = this.root.getElementById('connection-status');
    this.drawPrompt = this.root.getElementById('draw-prompt');
    this.drawHud = this.root.getElementById('draw-hud');

    this.colorInput = this.root.getElementById('stroke-color');
    this.thicknessInput = this.root.getElementById('stroke-size');
    this.sizeValue = this.root.getElementById('stroke-size-value');
    this.toolBrush = this.root.getElementById('tool-brush');
    this.toolErase = this.root.getElementById('tool-erase');

    this.debugPanel = this.root.getElementById('debug-panel');
    this.debugExpanded = false;

    this.tool = 'brush';
    this._bindInputs();
  }

  bindStart(handler) {
    if (!this.startButton) {
      return;
    }
    this.startButton.addEventListener('click', () => {
      this.instructionsOverlay?.classList.add('hidden');
      handler();
    });
  }

  setLoadingProgress(progressRatio, label = 'Loading assets') {
    const clamped = Math.max(0, Math.min(1, progressRatio || 0));
    if (this.loadingBarFill) {
      this.loadingBarFill.style.width = `${Math.round(clamped * 100)}%`;
    }
    if (this.loadingLabel) {
      this.loadingLabel.textContent = `${label} ${Math.round(clamped * 100)}%`;
    }
  }

  hideLoading() {
    if (!this.loadingOverlay) {
      return;
    }
    this.loadingOverlay.classList.add('hidden');
  }

  showFatalError(message) {
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.remove('hidden');
    }

    if (this.loadingLabel) {
      this.loadingLabel.textContent = message;
    }

    if (this.loadingBarFill) {
      this.loadingBarFill.style.width = '100%';
      this.loadingBarFill.style.background = 'linear-gradient(90deg, #ff6a6a, #ffb36a)';
    }

    const panel = this.root.querySelector('.loading-panel');
    panel?.classList.add('boot-error');
  }

  setConnectionStatus(connected) {
    if (!this.connectionStatus) {
      return;
    }

    if (connected) {
      this.connectionStatus.textContent = 'Online';
      this.connectionStatus.classList.add('connected');
      this.connectionStatus.classList.remove('disconnected');
    } else {
      this.connectionStatus.textContent = 'Offline';
      this.connectionStatus.classList.add('disconnected');
      this.connectionStatus.classList.remove('connected');
    }
  }

  setDrawPrompt(visible, message = 'Press E to paint') {
    if (!this.drawPrompt) {
      return;
    }
    this.drawPrompt.textContent = message;
    this.drawPrompt.classList.toggle('visible', !!visible);
  }

  setDrawMode(active) {
    if (!this.drawHud) {
      return;
    }
    this.drawHud.classList.toggle('visible', !!active);
  }

  getTool() {
    return this.tool;
  }

  getBrushColor() {
    return this.colorInput ? this.colorInput.value : '#ff3d3d';
  }

  getBrushSize() {
    return this.thicknessInput ? Number(this.thicknessInput.value) : 6;
  }

  setDebugExpanded(expanded) {
    this.debugExpanded = expanded === true;
    if (this.debugPanel) {
      this.debugPanel.classList.toggle('expanded', this.debugExpanded);
    }
  }

  updateDebug(stats) {
    if (!this.debugPanel) {
      return;
    }

    const memory = stats.memoryMB != null ? `${stats.memoryMB.toFixed(1)} MB` : 'n/a';
    if (this.debugExpanded && stats.diagnosticsEnabled === true) {
      const timings = stats.timings || {};
      const movement = stats.movement || {};
      const fmtMs = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}ms` : 'n/a');
      const fmtNum = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');
      const forwardAxis = Number.isFinite(movement.inputAxes?.forward) ? movement.inputAxes.forward : 0;
      const strafeAxis = Number.isFinite(movement.inputAxes?.strafe) ? movement.inputAxes.strafe : 0;

      this.debugPanel.textContent = (
        `FPS ${stats.fps.toFixed(1)} | Frame ${fmtMs(stats.frameMs)} | Draw ${stats.drawCalls} | Triangles ${stats.triangles} | Memory ${memory}\n`
        + `Long ${stats.longFrames || 0} (> ${stats.longFrameThresholdMs || 120}ms) | `
        + `Hitch ${stats.hitchCount || 0} | `
        + `M ${fmtMs(timings.movement)} P ${fmtMs(timings.player)} C ${fmtMs(timings.camera)} D ${fmtMs(timings.drawing)} S ${fmtMs(timings.sync)} R ${fmtMs(timings.render)}\n`
        + `Input ${movement.inputActive ? 'active' : 'idle'} (${forwardAxis}/${strafeAxis}) | Turn ${movement.rotateToInput ? 'yes' : 'no'} | Speed ${fmtNum(movement.speed)} | Ground ${movement.onGround ? 'yes' : 'no'} | `
        + `Yaw in ${fmtNum(movement.inputYaw)} / player ${fmtNum(movement.playerYaw)} | F3 toggle`
      );
      return;
    }

    this.debugPanel.textContent = `FPS ${stats.fps.toFixed(1)} | Draw ${stats.drawCalls} | Triangles ${stats.triangles} | Memory ${memory}`;
  }

  _bindInputs() {
    if (this.thicknessInput && this.sizeValue) {
      this.sizeValue.textContent = `${this.thicknessInput.value}px`;
      this.thicknessInput.addEventListener('input', () => {
        this.sizeValue.textContent = `${this.thicknessInput.value}px`;
      });
    }

    if (this.toolBrush && this.toolErase) {
      this.toolBrush.addEventListener('click', () => {
        this.tool = 'brush';
        this.toolBrush.classList.add('active');
        this.toolErase.classList.remove('active');
      });

      this.toolErase.addEventListener('click', () => {
        this.tool = 'erase';
        this.toolErase.classList.add('active');
        this.toolBrush.classList.remove('active');
      });
    }
  }
}
