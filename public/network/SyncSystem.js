export class SyncSystem {
  constructor(socketManager, playerController, drawingSystem, uiManager, options = {}) {
    this.socketManager = socketManager;
    this.playerController = playerController;
    this.drawingSystem = drawingSystem;
    this.uiManager = uiManager;
    this.apiBaseUrl = this._normalizeBaseUrl(options.apiBaseUrl);

    this.playerSendAccumulator = 0;
    this.playerSendInterval = 0.05;
    this.selfId = null;

    this._bindEvents();
  }

  async bootstrap() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(this._buildApiUrl('/api/state'), {
        cache: 'no-store',
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`State request failed: ${response.status}`);
      }

      const state = await response.json();
      if (Array.isArray(state.strokes)) {
        this.drawingSystem.applyInitialStrokes(state.strokes);
      }
      if (Array.isArray(state.players)) {
        for (const player of state.players) {
          if (player.id !== this.selfId) {
            this.playerController.upsertRemotePlayer(player.id, player);
          }
        }
      }
    } catch (error) {
      console.warn('State bootstrap failed, continuing offline:', error);
    } finally {
      clearTimeout(timeout);
    }
  }

  _buildApiUrl(path) {
    if (!this.apiBaseUrl) {
      return path;
    }

    return `${this.apiBaseUrl}${path}`;
  }

  _normalizeBaseUrl(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/$/, '');
  }

  connect() {
    this.socketManager.connect();
  }

  update(deltaSeconds) {
    if (!this.socketManager.connected) {
      return;
    }

    this.playerSendAccumulator += deltaSeconds;
    if (this.playerSendAccumulator >= this.playerSendInterval) {
      this.playerSendAccumulator = 0;
      this.socketManager.emit('player:update', this.playerController.getLocalNetworkState());
    }
  }

  _bindEvents() {
    this.drawingSystem.setStrokeSendCallback((packet) => {
      this.socketManager.emit('stroke:add', packet);
    });

    this.socketManager.on('connect', ({ id }) => {
      this.selfId = id;
      this.uiManager.setConnectionStatus(true);
      this.socketManager.emit('player:join', this.playerController.getLocalNetworkState());
    });

    this.socketManager.on('disconnect', () => {
      this.uiManager.setConnectionStatus(false);
    });

    this.socketManager.on('connect_error', () => {
      this.uiManager.setConnectionStatus(false);
    });

    this.socketManager.on('state:init', (payload) => {
      if (!payload) {
        return;
      }

      if (Array.isArray(payload.strokes)) {
        this.drawingSystem.applyInitialStrokes(payload.strokes);
      }

      if (Array.isArray(payload.players)) {
        for (const player of payload.players) {
          if (player.id !== this.selfId) {
            this.playerController.upsertRemotePlayer(player.id, player);
          }
        }
      }
    });

    this.socketManager.on('player:update', (payload) => {
      if (!payload || payload.id === this.selfId) {
        return;
      }
      this.playerController.upsertRemotePlayer(payload.id, payload);
    });

    this.socketManager.on('player:leave', (payload) => {
      if (!payload || !payload.id) {
        return;
      }
      this.playerController.removeRemotePlayer(payload.id);
    });

    this.socketManager.on('stroke:add', (packet) => {
      if (!packet) {
        return;
      }
      if (packet.playerId && packet.playerId === this.selfId) {
        return;
      }
      this.drawingSystem.applyStrokePacket(packet);
    });
  }
}
