export class SyncSystem {
  constructor(socketManager, playerController, drawingSystem, uiManager, options = {}) {
    this.socketManager = socketManager;
    this.playerController = playerController;
    this.drawingSystem = drawingSystem;
    this.uiManager = uiManager;
    this.apiBaseUrl = this._normalizeBaseUrl(options.apiBaseUrl);

    this.playerSendAccumulator = 0;
    this.playerSendIntervalMoving = 1 / 30;
    this.playerSendIntervalIdle = 0.1;
    this.profileHeartbeatAccumulator = 0;
    this.profileHeartbeatInterval = 1.25;
    this.lastSentPlayerState = null;
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
            this.playerController.setRemoteDrawCursor(player.id, player.drawCursor);
          }
        }
      }
    } catch (error) {
      await this._bootstrapLegacyFallback(error);
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

  _buildLocalPlayerState() {
    const state = this.playerController.getLocalNetworkState();
    state.drawCursor = this.drawingSystem.getLocalDrawCursorState();
    return state;
  }

  async _bootstrapLegacyFallback(rootError) {
    // Gracefully handle older backends that only expose /api/drawings.
    try {
      const statusResponse = await fetch(this._buildApiUrl('/api/status'), { cache: 'no-store' });
      if (statusResponse.ok) {
        const statusPayload = await statusResponse.json();
        const apiVersion = statusPayload?.apiVersion || 'legacy';
        if (!String(apiVersion).includes('strokes-v')) {
          console.warn(
            '[Sync] Backend API mismatch. Expected strokes-v* backend, got %o. Multiplayer players and stroke sync may fail until backend is updated.',
            statusPayload
          );
        }
      }
    } catch {
      // Ignore status probing errors and continue to drawings probe.
    }

    try {
      const drawingsResponse = await fetch(this._buildApiUrl('/api/drawings'), { cache: 'no-store' });
      if (!drawingsResponse.ok) {
        throw new Error(`Legacy drawings request failed: ${drawingsResponse.status}`);
      }

      const drawings = await drawingsResponse.json();
      if (Array.isArray(drawings) && drawings.length > 0) {
        const looksLikeStrokePackets = drawings.every((entry) => (
          entry
          && typeof entry === 'object'
          && entry.patch
          && Array.isArray(entry.points)
        ));

        if (looksLikeStrokePackets) {
          this.drawingSystem.applyInitialStrokes(drawings);
          return;
        }
      }
    } catch (legacyError) {
      console.warn('Legacy drawings bootstrap failed:', legacyError);
    }

    console.warn('State bootstrap failed, continuing offline:', rootError);
  }

  connect() {
    this.socketManager.connect();
  }

  update(deltaSeconds) {
    if (!this.socketManager.connected) {
      return;
    }

    const state = this._buildLocalPlayerState();
    const activeMovement = this._isMovementActive(state, this.lastSentPlayerState);
    const sendInterval = activeMovement ? this.playerSendIntervalMoving : this.playerSendIntervalIdle;

    this.profileHeartbeatAccumulator += deltaSeconds;
    if (this.profileHeartbeatAccumulator >= this.profileHeartbeatInterval) {
      this.profileHeartbeatAccumulator %= this.profileHeartbeatInterval;
      this.socketManager.emit('player:update', state);
      this.lastSentPlayerState = state;
    }

    this.playerSendAccumulator += deltaSeconds;
    if (this.playerSendAccumulator >= sendInterval) {
      this.playerSendAccumulator %= sendInterval;
      this.socketManager.emitVolatile('player:update', state);
      this.lastSentPlayerState = state;
    }
  }

  _isMovementActive(next, previous) {
    if (!next?.position || !previous?.position) {
      return true;
    }

    const dx = Number(next.position.x) - Number(previous.position.x);
    const dy = Number(next.position.y) - Number(previous.position.y);
    const dz = Number(next.position.z) - Number(previous.position.z);
    const positionDeltaSq = (dx * dx) + (dy * dy) + (dz * dz);
    if (positionDeltaSq > 0.0004) {
      return true;
    }

    const yawDelta = Math.abs((Number(next.rotationY) || 0) - (Number(previous.rotationY) || 0));
    return yawDelta > 0.015;
  }

  _bindEvents() {
    this.uiManager.bindChat(
      (message) => {
        this.playerController.setLocalChatMessage(message);
        if (this.socketManager.connected) {
          this.socketManager.emit('chat:message', { message });
        }
      },
      (typing) => {
        this.playerController.setLocalTyping(typing === true);
        if (this.socketManager.connected) {
          this.socketManager.emit('chat:typing', { typing: typing === true });
        }
      }
    );

    this.drawingSystem.setStrokeSendCallback((packet) => {
      this.socketManager.emit('stroke:add', packet);
    });
    this.drawingSystem.setStrokeLiveSendCallback((packet) => {
      this.socketManager.emit('stroke:live', packet);
    });

    this.socketManager.on('connect', ({ id }) => {
      this.selfId = id;
      this.uiManager.setConnectionStatus(true);
      this.playerController.setLocalPlayerId(id);
      const profile = this._buildLocalPlayerState();
      this.socketManager.emit('player:join', profile);
      this.socketManager.emit('player:update', profile);
      this._verifyServerFeatureSupport();
    });

    this.socketManager.on('disconnect', () => {
      this.uiManager.setConnectionStatus(false);
      this.playerController.setLocalTyping(false);
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
            this.playerController.setRemoteDrawCursor(player.id, player.drawCursor);
          }
        }
      }
    });

    this.socketManager.on('player:update', (payload) => {
      if (!payload || payload.id === this.selfId) {
        return;
      }
      this.playerController.upsertRemotePlayer(payload.id, payload);
      this.playerController.setRemoteDrawCursor(payload.id, payload.drawCursor);
      if (typeof payload.color === 'string') {
        this.playerController.setRemotePlayerColor(payload.id, payload.color);
      }
      if (typeof payload.name === 'string') {
        this.playerController.setRemotePlayerName(payload.id, payload.name);
      }
    });

    this.socketManager.on('player:leave', (payload) => {
      if (!payload || !payload.id) {
        return;
      }
      this.drawingSystem.clearRemoteLiveStrokesForPlayer(payload.id);
      this.playerController.removeRemotePlayer(payload.id);
    });

    this.socketManager.on('chat:message', (payload) => {
      if (!payload || typeof payload.id !== 'string' || typeof payload.message !== 'string') {
        return;
      }

      if (payload.id === this.selfId) {
        this.playerController.setLocalChatMessage(payload.message);
        this.playerController.setLocalTyping(false);
      } else {
        this.playerController.setRemoteChatMessage(payload.id, payload.message);
        this.playerController.setRemoteTyping(payload.id, false);
      }
    });

    this.socketManager.on('chat:typing', (payload) => {
      if (!payload || typeof payload.id !== 'string') {
        return;
      }

      const typing = payload.typing === true;
      if (payload.id === this.selfId) {
        this.playerController.setLocalTyping(typing);
      } else {
        this.playerController.setRemoteTyping(payload.id, typing);
      }
    });

    this.socketManager.on('stroke:live', (packet) => {
      if (!packet) {
        return;
      }
      if (packet.playerId && packet.playerId === this.selfId) {
        return;
      }
      this.drawingSystem.applyStrokePacket(packet);
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

  async _verifyServerFeatureSupport() {
    try {
      const response = await fetch(this._buildApiUrl('/api/status'), {
        cache: 'no-store'
      });
      if (!response.ok) {
        return;
      }

      const status = await response.json();
      const apiVersion = String(status?.apiVersion || '').trim();
      const features = status?.features || {};
      const supportsChat = features.chat === true;
      const supportsProfile = features.playerProfile === true;

      if (!apiVersion.includes('chat-profile') || !supportsChat || !supportsProfile) {
        console.warn(
          '[Sync] Server lacks chat/profile sync support. Restart backend with latest server.js. status=%o',
          status
        );
      }
    } catch {
      // Non-fatal.
    }
  }
}
