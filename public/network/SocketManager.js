export class SocketManager {
  constructor(options = {}) {
    this.socket = null;
    this.handlers = new Map();
    this.connected = false;
    this.ioLoadPromise = null;
    this.socketUrl = this._normalizeBaseUrl(options.socketUrl);
  }

  connect() {
    void this._connectInternal();
  }

  emit(event, payload) {
    if (!this.socket || !this.connected) {
      return;
    }
    this.socket.emit(event, payload);
  }

  on(event, callback) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(callback);
  }

  getId() {
    return this.socket ? this.socket.id : null;
  }

  async _connectInternal() {
    const ioFactory = await this._getIoFactory();
    if (typeof ioFactory !== 'function') {
      this._emitLocal('connect_error', { error: new Error('Socket.IO client unavailable') });
      return;
    }

    try {
      const connectionOptions = {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000
      };

      this.socket = this.socketUrl
        ? ioFactory(this.socketUrl, connectionOptions)
        : ioFactory(connectionOptions);

      this.socket.on('connect', () => {
        this.connected = true;
        this._emitLocal('connect', { id: this.socket.id });
      });

      this.socket.on('disconnect', (reason) => {
        this.connected = false;
        this._emitLocal('disconnect', { reason });
      });

      this.socket.on('connect_error', (error) => {
        this._emitLocal('connect_error', { error });
      });

      this.socket.onAny((event, payload) => {
        this._emitLocal(event, payload);
      });
    } catch (error) {
      this._emitLocal('connect_error', { error });
    }
  }

  async _getIoFactory() {
    if (!this.socketUrl && this._isGithubPagesHost()) {
      return null;
    }

    if (typeof globalThis.io === 'function') {
      return globalThis.io;
    }

    if (!this.ioLoadPromise) {
      const scriptUrl = this._resolveSocketIoScriptUrl();
      this.ioLoadPromise = this._loadIoScript(scriptUrl, 1200)
        .then(() => (typeof globalThis.io === 'function' ? globalThis.io : null))
        .catch(() => null);
    }

    return this.ioLoadPromise;
  }

  _loadIoScript(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-socketio-loader="1"][src="${src}"]`);
      if (existing) {
        if (typeof globalThis.io === 'function') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Socket.IO script failed to load')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.socketioLoader = '1';

      const timer = setTimeout(() => {
        script.remove();
        reject(new Error(`Socket.IO script load timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      script.onload = () => {
        clearTimeout(timer);
        resolve();
      };

      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Socket.IO script failed to load'));
      };

      document.head.appendChild(script);
    });
  }

  _resolveSocketIoScriptUrl() {
    if (!this.socketUrl) {
      return '/socket.io/socket.io.js';
    }

    try {
      return new URL('/socket.io/socket.io.js', this.socketUrl).toString();
    } catch {
      return '/socket.io/socket.io.js';
    }
  }

  _isGithubPagesHost() {
    const hostname = globalThis?.location?.hostname;
    return typeof hostname === 'string' && hostname.endsWith('.github.io');
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

  _emitLocal(event, payload) {
    const callbacks = this.handlers.get(event);
    if (!callbacks || callbacks.length === 0) {
      return;
    }

    for (const callback of callbacks) {
      callback(payload);
    }
  }
}
