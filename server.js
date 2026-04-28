const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { pack, unpack } = require('msgpackr');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e6,
  pingTimeout: 25000,
  pingInterval: 10000
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

let clientWatchProcess = null;
const watchClient = process.argv.includes('--watch-client') || process.env.WATCH_CLIENT === '1';

if (watchClient) {
  clientWatchProcess = spawn(process.execPath, [path.join(__dirname, 'scripts', 'build-client.mjs'), '--watch'], {
    stdio: 'inherit',
    windowsHide: true
  });

  const stopClientWatch = () => {
    if (clientWatchProcess && !clientWatchProcess.killed) {
      clientWatchProcess.kill();
    }
  };

  process.on('exit', stopClientWatch);
  process.on('SIGINT', () => {
    stopClientWatch();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopClientWatch();
    process.exit(0);
  });
}

const STORAGE_ROOT = process.env.DRAWINGS_DIR
  ? path.resolve(process.env.DRAWINGS_DIR)
  : path.join(__dirname, 'drawings');
const STROKES_DIR = path.join(STORAGE_ROOT, 'strokes');
const API_VERSION = 'strokes-v3-chat-profile';

const MAX_STROKES = 12000;
const MAX_POINTS_PER_STROKE = 320;
const MAX_ERASE_TARGETS = 64;
const MAX_CHAT_LENGTH = 96;
const CHAT_MIN_INTERVAL_MS = 700;
const CHAT_DUPLICATE_WINDOW_MS = 8000;
const CHAT_RATE_WINDOW_MS = 10000;
const CHAT_RATE_MAX_MESSAGES = 6;
const MAX_PLAYER_NAME_LENGTH = 18;

const strokes = new Map();
const players = new Map();
const chatModeration = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeVec3Array(vector) {
  if (!Array.isArray(vector) || vector.length !== 3) {
    return null;
  }

  const x = Number(vector[0]);
  const y = Number(vector[1]);
  const z = Number(vector[2]);

  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return null;
  }

  return [x, y, z];
}

function sanitizePatch(patch) {
  if (!patch || typeof patch !== 'object') {
    return null;
  }

  const center = sanitizeVec3Array(patch.center);
  const normal = sanitizeVec3Array(patch.normal);
  const tangent = sanitizeVec3Array(patch.tangent);
  const bitangent = sanitizeVec3Array(patch.bitangent);
  const halfSize = Number(patch.halfSize);

  if (!center || !normal || !tangent || !bitangent || !isFiniteNumber(halfSize)) {
    return null;
  }

  const meshId = Number.isFinite(Number(patch.meshId)) ? Number(patch.meshId) : -1;

  return {
    key: typeof patch.key === 'string' ? patch.key : '',
    meshId,
    center,
    normal,
    tangent,
    bitangent,
    halfSize: clamp(halfSize, 0.5, 8)
  };
}

function sanitizeHexColor(value, fallback = '#1b69fa') {
  const normalized = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function sanitizePlayerName(value, fallback = 'Writer') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PLAYER_NAME_LENGTH);
  return normalized || fallback;
}

function sanitizeStrokePacket(packet, playerId) {
  if (!packet || typeof packet !== 'object') {
    return null;
  }

  if (packet.erase === true) {
    if (typeof packet.id !== 'string' || !Array.isArray(packet.targets)) {
      return null;
    }

    const targets = packet.targets
      .filter((target) => typeof target === 'string')
      .slice(0, MAX_ERASE_TARGETS);

    return {
      id: packet.id,
      erase: true,
      patchKey: typeof packet.patchKey === 'string' ? packet.patchKey : '',
      targets,
      createdAt: Number(packet.createdAt) || Date.now(),
      playerId
    };
  }

  if (
    typeof packet.id !== 'string' ||
    typeof packet.patchKey !== 'string' ||
    !packet.patch ||
    !Array.isArray(packet.points)
  ) {
    return null;
  }

  const patch = sanitizePatch(packet.patch);
  if (!patch) {
    return null;
  }

  if (packet.points.length < 4 || packet.points.length > MAX_POINTS_PER_STROKE * 2 || packet.points.length % 2 !== 0) {
    return null;
  }

  const quantization = Number(packet.q);
  if (!isFiniteNumber(quantization) || quantization <= 0 || quantization > 10000) {
    return null;
  }

  const points = [];
  for (let i = 0; i < packet.points.length; i += 1) {
    const value = Number(packet.points[i]);
    if (!Number.isInteger(value) || value < -32768 || value > 32767) {
      return null;
    }
    points.push(value);
  }

  const color = typeof packet.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(packet.color)
    ? packet.color
    : '#ff3d3d';

  const thickness = clamp(Number(packet.thickness) || 6, 1, 24);

  return {
    v: 1,
    id: packet.id,
    liveId: typeof packet.liveId === 'string' ? packet.liveId : null,
    patchKey: packet.patchKey,
    patch,
    color,
    thickness,
    q: quantization,
    points,
    createdAt: Number(packet.createdAt) || Date.now(),
    playerId
  };
}

function sanitizeLiveStrokePacket(packet, playerId) {
  if (!packet || typeof packet !== 'object' || typeof packet.id !== 'string') {
    return null;
  }

  const base = {
    v: 1,
    live: true,
    id: packet.id,
    patchKey: typeof packet.patchKey === 'string' ? packet.patchKey : '',
    createdAt: Number(packet.createdAt) || Date.now(),
    playerId
  };

  if (packet.end === true) {
    return {
      ...base,
      end: true
    };
  }

  if (!packet.patch || !Array.isArray(packet.points)) {
    return null;
  }

  const patch = sanitizePatch(packet.patch);
  if (!patch) {
    return null;
  }

  if (packet.points.length < 4 || packet.points.length > MAX_POINTS_PER_STROKE * 2 || packet.points.length % 2 !== 0) {
    return null;
  }

  const quantization = Number(packet.q);
  if (!isFiniteNumber(quantization) || quantization <= 0 || quantization > 10000) {
    return null;
  }

  const points = [];
  for (let i = 0; i < packet.points.length; i += 1) {
    const value = Number(packet.points[i]);
    if (!Number.isInteger(value) || value < -32768 || value > 32767) {
      return null;
    }
    points.push(value);
  }

  const color = typeof packet.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(packet.color)
    ? packet.color
    : '#ff3d3d';
  const thickness = clamp(Number(packet.thickness) || 6, 1, 24);

  return {
    ...base,
    patch,
    color,
    thickness,
    q: quantization,
    points
  };
}

function sanitizePlayerState(payload, socketId) {
  if (!payload || typeof payload !== 'object' || !payload.position) {
    return null;
  }

  const x = Number(payload.position.x);
  const y = Number(payload.position.y);
  const z = Number(payload.position.z);
  const rotationY = Number(payload.rotationY) || 0;
  const previousColor = players.get(socketId)?.color || '#1b69fa';
  const previousName = players.get(socketId)?.name || 'Writer';
  const color = sanitizeHexColor(payload.color, previousColor);
  const name = sanitizePlayerName(payload.name, previousName);

  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return null;
  }

  return {
    id: socketId,
    position: {
      x: clamp(x, -5000, 5000),
      y: clamp(y, -100, 500),
      z: clamp(z, -5000, 5000)
    },
    rotationY,
    color,
    name,
    timestamp: Date.now()
  };
}

function sanitizeChatMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const message = String(payload.message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH);

  return message || null;
}

function passesChatSpamFilter(socketId, message) {
  const now = Date.now();
  const normalizedMessage = String(message || '').trim().toLowerCase();
  const state = chatModeration.get(socketId) || {
    lastMessageAt: 0,
    lastMessageNormalized: '',
    timeline: []
  };

  if (now - state.lastMessageAt < CHAT_MIN_INTERVAL_MS) {
    return false;
  }

  if (
    normalizedMessage
    && normalizedMessage === state.lastMessageNormalized
    && now - state.lastMessageAt < CHAT_DUPLICATE_WINDOW_MS
  ) {
    return false;
  }

  state.timeline = state.timeline.filter((timestamp) => (now - timestamp) <= CHAT_RATE_WINDOW_MS);
  if (state.timeline.length >= CHAT_RATE_MAX_MESSAGES) {
    return false;
  }

  state.timeline.push(now);
  state.lastMessageAt = now;
  state.lastMessageNormalized = normalizedMessage;
  chatModeration.set(socketId, state);
  return true;
}

function strokePath(strokeId) {
  const safeId = strokeId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return {
    binary: path.join(STROKES_DIR, `${safeId}.mpk`),
    legacyJson: path.join(STROKES_DIR, `${safeId}.json`)
  };
}

async function ensureStorage() {
  await fsp.mkdir(STROKES_DIR, { recursive: true });
}

async function loadStrokesFromDisk() {
  await ensureStorage();
  const files = await fsp.readdir(STROKES_DIR);

  let loaded = 0;
  for (const file of files) {
    if (!file.endsWith('.json') && !file.endsWith('.mpk')) {
      continue;
    }

    try {
      const absolutePath = path.join(STROKES_DIR, file);
      let parsed = null;

      if (file.endsWith('.mpk')) {
        const payload = await fsp.readFile(absolutePath);
        parsed = unpack(payload);
      } else {
        const payload = await fsp.readFile(absolutePath, 'utf8');
        parsed = JSON.parse(payload);
      }

      const sanitized = sanitizeStrokePacket(parsed, parsed.playerId || 'persisted');
      if (!sanitized || sanitized.erase) {
        continue;
      }
      strokes.set(sanitized.id, sanitized);
      loaded += 1;
    } catch (error) {
      console.error(`Failed to load stroke file ${file}:`, error.message);
    }
  }

  console.log(`Loaded ${loaded} strokes from disk`);
}

async function saveStrokeToDisk(stroke) {
  const target = strokePath(stroke.id);
  try {
    await fsp.writeFile(target.binary, pack(stroke));

    if (fs.existsSync(target.legacyJson)) {
      await fsp.unlink(target.legacyJson);
    }
  } catch (error) {
    console.error('Failed to persist stroke:', error.message);
  }
}

async function deleteStrokeFromDisk(strokeId) {
  const target = strokePath(strokeId);
  try {
    if (fs.existsSync(target.binary)) {
      await fsp.unlink(target.binary);
    }
    if (fs.existsSync(target.legacyJson)) {
      await fsp.unlink(target.legacyJson);
    }
  } catch (error) {
    console.error(`Failed to delete stroke ${strokeId}:`, error.message);
  }
}

async function pruneStrokeCacheIfNeeded() {
  if (strokes.size <= MAX_STROKES) {
    return;
  }

  const ordered = Array.from(strokes.values())
    .sort((a, b) => a.createdAt - b.createdAt);

  const removeCount = strokes.size - MAX_STROKES;
  const removeList = ordered.slice(0, removeCount);

  for (const stroke of removeList) {
    strokes.delete(stroke.id);
    await deleteStrokeFromDisk(stroke.id);
  }
}

function getSerializablePlayers() {
  return Array.from(players.values());
}

function getSerializableStrokes() {
  return Array.from(strokes.values())
    .sort((a, b) => a.createdAt - b.createdAt);
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    apiVersion: API_VERSION,
    features: {
      chat: true,
      playerProfile: true,
      liveStroke: true
    },
    drawingsCount: strokes.size,
    drawingsList: Array.from(strokes.keys()),
    strokes: strokes.size,
    players: players.size,
    storageRoot: STORAGE_ROOT,
    strokesDir: STROKES_DIR
  });
});

app.get('/api/state', (req, res) => {
  res.json({
    serverTime: Date.now(),
    strokes: getSerializableStrokes(),
    players: getSerializablePlayers()
  });
});

app.get('/api/strokes', (req, res) => {
  res.json(getSerializableStrokes());
});

app.post('/api/strokes', async (req, res) => {
  const stroke = sanitizeStrokePacket(req.body, 'rest');
  if (!stroke || stroke.erase) {
    res.status(400).json({ error: 'Invalid stroke payload' });
    return;
  }

  if (strokes.has(stroke.id)) {
    res.status(200).json({ ok: true, deduped: true });
    return;
  }

  strokes.set(stroke.id, stroke);
  await saveStrokeToDisk(stroke);
  await pruneStrokeCacheIfNeeded();

  io.emit('stroke:add', stroke);
  res.status(201).json({ ok: true });
});

app.get('/api/drawings', (req, res) => {
  res.json(getSerializableStrokes());
});

// Backward-compatible alias for older clients.
app.post('/api/drawings', async (req, res) => {
  const stroke = sanitizeStrokePacket(req.body, 'rest');
  if (!stroke || stroke.erase) {
    res.status(400).json({ error: 'Invalid stroke payload' });
    return;
  }

  if (strokes.has(stroke.id)) {
    res.status(200).json({ ok: true, deduped: true });
    return;
  }

  strokes.set(stroke.id, stroke);
  await saveStrokeToDisk(stroke);
  await pruneStrokeCacheIfNeeded();

  io.emit('stroke:add', stroke);
  res.status(201).json({ ok: true });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.emit('state:init', {
    serverTime: Date.now(),
    strokes: getSerializableStrokes(),
    players: getSerializablePlayers()
  });

  socket.on('player:join', (payload) => {
    const player = sanitizePlayerState(payload, socket.id);
    if (!player) {
      return;
    }

    players.set(socket.id, player);
    io.emit('player:update', player);
  });

  socket.on('player:update', (payload) => {
    const player = sanitizePlayerState(payload, socket.id);
    if (!player) {
      return;
    }

    players.set(socket.id, player);
    socket.broadcast.emit('player:update', player);
  });

  socket.on('stroke:add', async (payload) => {
    const packet = sanitizeStrokePacket(payload, socket.id);
    if (!packet) {
      return;
    }

    if (packet.erase === true) {
      for (const strokeId of packet.targets) {
        strokes.delete(strokeId);
        await deleteStrokeFromDisk(strokeId);
      }
      io.emit('stroke:add', packet);
      return;
    }

    if (strokes.has(packet.id)) {
      return;
    }

    strokes.set(packet.id, packet);
    await saveStrokeToDisk(packet);
    await pruneStrokeCacheIfNeeded();

    io.emit('stroke:add', packet);
  });

  socket.on('stroke:live', (payload) => {
    const packet = sanitizeLiveStrokePacket(payload, socket.id);
    if (!packet) {
      return;
    }

    socket.broadcast.emit('stroke:live', packet);
  });

  socket.on('chat:message', (payload) => {
    const message = sanitizeChatMessage(payload);
    if (!message) {
      return;
    }
    if (!passesChatSpamFilter(socket.id, message)) {
      return;
    }

    io.emit('chat:message', {
      id: socket.id,
      message,
      createdAt: Date.now()
    });
  });

  socket.on('chat:typing', (payload) => {
    const typing = payload?.typing === true;
    socket.broadcast.emit('chat:typing', {
      id: socket.id,
      typing
    });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    chatModeration.delete(socket.id);
    io.emit('chat:typing', { id: socket.id, typing: false });
    io.emit('player:leave', { id: socket.id });
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

(async () => {
  try {
    await loadStrokesFromDisk();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on http://127.0.0.1:${PORT}`);
      console.log(`Open client at http://127.0.0.1:${PORT}/public/index.html`);
      console.log(`Persisted strokes: ${strokes.size}`);
      console.log(`API mode: ${API_VERSION}`);
      console.log(`Storage root: ${STORAGE_ROOT}`);
      console.log(`Strokes dir: ${STROKES_DIR}`);
    });
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
})();
