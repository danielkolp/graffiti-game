function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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

    this.colorWheelWrap = this.root.getElementById('stroke-color-wheel-wrap');
    this.colorWheel = this.root.getElementById('stroke-color-wheel');
    this.colorWheelCursor = this.root.getElementById('stroke-color-wheel-cursor');
    this.colorPreview = this.root.getElementById('stroke-color-preview');
    this.colorHexLabel = this.root.getElementById('stroke-color-hex');
    this.valueInput = this.root.getElementById('stroke-value');
    this.valueLabel = this.root.getElementById('stroke-value-label');
    this.rgbRInput = this.root.getElementById('stroke-r');
    this.rgbGInput = this.root.getElementById('stroke-g');
    this.rgbBInput = this.root.getElementById('stroke-b');
    this.thicknessInput = this.root.getElementById('stroke-size');
    this.sizeValue = this.root.getElementById('stroke-size-value');
    this.toolBrush = this.root.getElementById('tool-brush');
    this.toolErase = this.root.getElementById('tool-erase');
    this.undoButton = this.root.getElementById('tool-undo');

    this.debugPanel = this.root.getElementById('debug-panel');
    this.debugExpanded = false;

    this.tool = 'brush';
    this.brushColor = '#ff8fbc';
    this.currentHue = 336;
    this.currentSaturation = 0.44;
    this.currentValue = 1;
    this.wheelDragging = false;
    this.drawModeActive = false;
    this.undoHandler = null;
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
    this.drawModeActive = active === true;
    if (!this.drawHud) {
      return;
    }
    this.drawHud.classList.toggle('visible', this.drawModeActive);
  }

  bindUndo(handler) {
    this.undoHandler = typeof handler === 'function' ? handler : null;
  }

  getTool() {
    return this.tool;
  }

  getBrushColor() {
    return this.brushColor || '#ff8fbc';
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
    if (this.colorWheel && this.colorWheelCursor) {
      this._initColorWheel();
    }

    if (this.valueInput && this.valueLabel) {
      this.valueLabel.textContent = `${this.valueInput.value}%`;
      this.valueInput.addEventListener('input', () => {
        const percent = Math.max(0, Math.min(100, Number(this.valueInput.value) || 0));
        this.currentValue = percent / 100;
        this.valueLabel.textContent = `${Math.round(percent)}%`;
        this._applyCurrentHsvToBrush();
      });
    }

    if (this.rgbRInput && this.rgbGInput && this.rgbBInput) {
      const onRgbInput = () => {
        const r = clamp(Number(this.rgbRInput.value), 0, 255);
        const g = clamp(Number(this.rgbGInput.value), 0, 255);
        const b = clamp(Number(this.rgbBInput.value), 0, 255);
        this.rgbRInput.value = String(Math.round(r));
        this.rgbGInput.value = String(Math.round(g));
        this.rgbBInput.value = String(Math.round(b));
        this._setBrushColorFromRgb(Math.round(r), Math.round(g), Math.round(b));
      };

      this.rgbRInput.addEventListener('input', onRgbInput);
      this.rgbGInput.addEventListener('input', onRgbInput);
      this.rgbBInput.addEventListener('input', onRgbInput);
    }

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

    if (this.undoButton) {
      this.undoButton.addEventListener('click', () => {
        this._invokeUndo();
      });
    }

    window.addEventListener('keydown', (event) => {
      if (!this.drawModeActive) {
        return;
      }

      const isUndoCombo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
      if (!isUndoCombo) {
        return;
      }

      event.preventDefault();
      this._invokeUndo();
    });

    this._syncColorPreview(this.brushColor);
  }

  _invokeUndo() {
    if (this.undoHandler) {
      this.undoHandler();
    }
  }

  _setBrushColor(color) {
    if (!color) {
      return;
    }
    this.brushColor = color;

    const hsv = this._hexToHsv(color);
    if (hsv) {
      this.currentHue = hsv.h;
      this.currentSaturation = hsv.s;
      this.currentValue = hsv.v;
      this._syncWheelCursorFromHsv();
      this._syncValueInputFromState();
      this._syncRgbInputsFromColor(color);
      this._syncColorPreview(color);
    }
  }

  _setBrushColorFromRgb(r, g, b) {
    const color = this._rgbToHex(r, g, b);
    this.brushColor = color;

    const hsv = this._rgbToHsv(r, g, b);
    this.currentHue = hsv.h;
    this.currentSaturation = hsv.s;
    this.currentValue = hsv.v;

    this._syncWheelCursorFromHsv();
    this._syncValueInputFromState();
    this._syncRgbInputsFromColor(color);
    this._syncColorPreview(color);
  }

  _applyCurrentHsvToBrush() {
    const color = this._hsvToHex(this.currentHue, this.currentSaturation, this.currentValue);
    this.brushColor = color;
    this._syncRgbInputsFromColor(color);
    this._syncColorPreview(color);
  }

  _syncColorPreview(color) {
    if (this.colorPreview) {
      this.colorPreview.style.backgroundColor = color;
    }

    if (this.colorHexLabel) {
      this.colorHexLabel.textContent = String(color || '').toLowerCase();
    }
  }

  _initColorWheel() {
    const ctx = this.colorWheel.getContext('2d');
    if (!ctx) {
      return;
    }

    this._renderColorWheel(ctx);

    const pickColor = (event) => {
      const rect = this.colorWheel.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * this.colorWheel.width;
      const y = ((event.clientY - rect.top) / rect.height) * this.colorWheel.height;

      const center = this.colorWheel.width * 0.5;
      const radius = center - 1;
      let dx = x - center;
      let dy = y - center;
      const distance = Math.hypot(dx, dy);

      if (distance > radius && distance > 0) {
        const scale = radius / distance;
        dx *= scale;
        dy *= scale;
      }

      const hueRadians = (Math.atan2(dy, dx) + (Math.PI * 2)) % (Math.PI * 2);
      const hue = (hueRadians / (Math.PI * 2)) * 360;
      const saturation = Math.max(0, Math.min(1, Math.hypot(dx, dy) / radius));
      this.currentHue = hue;
      this.currentSaturation = saturation;
      this._applyCurrentHsvToBrush();
      this._setColorWheelCursor(center + dx, center + dy);
    };

    this.colorWheel.addEventListener('pointerdown', (event) => {
      this.wheelDragging = true;
      pickColor(event);
      this.colorWheel.setPointerCapture?.(event.pointerId);
    });

    this.colorWheel.addEventListener('pointermove', (event) => {
      if (!this.wheelDragging) {
        return;
      }
      pickColor(event);
    });

    const endDrag = () => {
      this.wheelDragging = false;
    };

    this.colorWheel.addEventListener('pointerup', endDrag);
    this.colorWheel.addEventListener('pointercancel', endDrag);
    this.colorWheel.addEventListener('pointerleave', endDrag);

    const hsv = this._hexToHsv(this.brushColor);
    if (hsv) {
      this.currentHue = hsv.h;
      this.currentSaturation = hsv.s;
      this.currentValue = hsv.v;
      this._syncWheelCursorFromHsv();
      this._syncValueInputFromState();
      this._syncRgbInputsFromColor(this.brushColor);
    }
  }

  _renderColorWheel(ctx) {
    const size = this.colorWheel.width;
    const image = ctx.createImageData(size, size);
    const center = size * 0.5;
    const radius = center - 1;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x - center;
        const dy = y - center;
        const dist = Math.hypot(dx, dy);
        const idx = (y * size + x) * 4;

        if (dist > radius) {
          image.data[idx + 3] = 0;
          continue;
        }

        const hueRadians = (Math.atan2(dy, dx) + (Math.PI * 2)) % (Math.PI * 2);
        const hue = (hueRadians / (Math.PI * 2)) * 360;
        const sat = Math.max(0, Math.min(1, dist / radius));
        const rgb = this._hsvToRgb(hue, sat, 1);

        image.data[idx] = rgb.r;
        image.data[idx + 1] = rgb.g;
        image.data[idx + 2] = rgb.b;
        image.data[idx + 3] = 255;
      }
    }

    ctx.putImageData(image, 0, 0);
  }

  _setColorWheelCursor(x, y) {
    const size = this.colorWheel.width;
    const leftPercent = (x / size) * 100;
    const topPercent = (y / size) * 100;
    this.colorWheelCursor.style.left = `${leftPercent}%`;
    this.colorWheelCursor.style.top = `${topPercent}%`;
  }

  _syncWheelCursorFromHsv() {
    if (!this.colorWheel || !this.colorWheelCursor) {
      return;
    }

    const angle = (this.currentHue / 360) * Math.PI * 2;
    const r = this.currentSaturation * (this.colorWheel.width * 0.5 - 1);
    const center = this.colorWheel.width * 0.5;
    this._setColorWheelCursor(
      center + (Math.cos(angle) * r),
      center + (Math.sin(angle) * r)
    );
  }

  _syncValueInputFromState() {
    if (!this.valueInput || !this.valueLabel) {
      return;
    }

    const percent = Math.round(clamp(this.currentValue * 100, 0, 100));
    this.valueInput.value = String(percent);
    this.valueLabel.textContent = `${percent}%`;
  }

  _syncRgbInputsFromColor(color) {
    if (!this.rgbRInput || !this.rgbGInput || !this.rgbBInput) {
      return;
    }

    const rgb = this._hexToRgb(color);
    if (!rgb) {
      return;
    }

    this.rgbRInput.value = String(rgb.r);
    this.rgbGInput.value = String(rgb.g);
    this.rgbBInput.value = String(rgb.b);
  }

  _hsvToRgb(h, s, v) {
    const c = v * s;
    const hh = (h % 360) / 60;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;

    if (hh >= 0 && hh < 1) {
      r = c;
      g = x;
    } else if (hh < 2) {
      r = x;
      g = c;
    } else if (hh < 3) {
      g = c;
      b = x;
    } else if (hh < 4) {
      g = x;
      b = c;
    } else if (hh < 5) {
      r = x;
      b = c;
    } else {
      r = c;
      b = x;
    }

    const m = v - c;
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  _hsvToHex(h, s, v) {
    const { r, g, b } = this._hsvToRgb(h, s, v);
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }

  _rgbToHex(r, g, b) {
    return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`;
  }

  _hexToRgb(hex) {
    const value = String(hex || '').trim().replace('#', '');
    if (value.length !== 6) {
      return null;
    }

    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return null;
    }

    return { r, g, b };
  }

  _rgbToHsv(r8, g8, b8) {
    const r = clamp(r8, 0, 255) / 255;
    const g = clamp(g8, 0, 255) / 255;
    const b = clamp(b8, 0, 255) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta > 0) {
      if (max === r) {
        h = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        h = 60 * (((b - r) / delta) + 2);
      } else {
        h = 60 * (((r - g) / delta) + 4);
      }
    }

    if (h < 0) {
      h += 360;
    }

    const s = max === 0 ? 0 : delta / max;
    return { h, s, v: max };
  }

  _hexToHsv(hex) {
    const value = String(hex || '').trim().replace('#', '');
    if (value.length !== 6) {
      return null;
    }

    const r = parseInt(value.slice(0, 2), 16) / 255;
    const g = parseInt(value.slice(2, 4), 16) / 255;
    const b = parseInt(value.slice(4, 6), 16) / 255;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return null;
    }

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta > 0) {
      if (max === r) {
        h = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        h = 60 * (((b - r) / delta) + 2);
      } else {
        h = 60 * (((r - g) / delta) + 4);
      }
    }

    if (h < 0) {
      h += 360;
    }

    const s = max === 0 ? 0 : delta / max;
    return { h, s, v: max };
  }
}

