#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = process.cwd();
const PATHS = {
  inbox: path.join(ROOT, 'cdp_inbox'),
  processing: path.join(ROOT, 'cdp_processing'),
  outbox: path.join(ROOT, 'cdp_outbox'),
  archive: path.join(ROOT, 'cdp_archive'),
  state: path.join(ROOT, 'cdp_state.json'),
  log: path.join(ROOT, 'cdp_daemon.log'),
  stdout: path.join(ROOT, 'cdp_daemon.stdout.log'),
  devtools: process.env.CHROME_DEVTOOLS_ACTIVE_PORT_PATH || path.join(os.homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
};

const SCAN_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 15000;
const CONNECT_TIMEOUT_MS = 8000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_OUTBOX_FILES = 300;
const MAX_ARCHIVE_FILES = 300;
let atomicWriteSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function atomicWriteJson(filePath, data) {
  atomicWriteSeq += 1;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${atomicWriteSeq}`;
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fsp.rename(tmpPath, filePath);
}

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async rotateIfNeeded() {
    try {
      const stat = await fsp.stat(this.filePath);
      if (stat.size <= MAX_LOG_BYTES) return;
      const backup = `${this.filePath}.1`;
      try { await fsp.unlink(backup); } catch {}
      await fsp.rename(this.filePath, backup);
    } catch {}
  }

  async write(level, message, extra) {
    const line = `[${nowIso()}] [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
    console.log(line);
    await this.rotateIfNeeded();
    await fsp.appendFile(this.filePath, line + '\n').catch(() => {});
  }

  info(message, extra) { return this.write('INFO', message, extra); }
  warn(message, extra) { return this.write('WARN', message, extra); }
  error(message, extra) { return this.write('ERROR', message, extra); }
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
    this.state = {
      pid: process.pid,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      connected: false,
      browserWsUrl: null,
      inboxDir: PATHS.inbox,
      processingDir: PATHS.processing,
      outboxDir: PATHS.outbox,
      archiveDir: PATHS.archive,
      processedCount: 0,
      lastRequestFile: null,
      lastError: null,
      sessions: {},
      ready: false,
    };
  }

  async update(patch = {}) {
    const nextState = { ...this.state, ...patch, updatedAt: nowIso() };
    this.state = nextState;
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => atomicWriteJson(this.filePath, nextState));
    return this.writeChain;
  }
}

class ChromeConnection {
  constructor(logger, state) {
    this.logger = logger;
    this.state = state;
    this.ws = null;
    this.browserWsUrl = null;
    this.connected = false;
    this.connecting = null;
    this.heartbeatTimer = null;
    this.nextMessageId = 1;
    this.pending = new Map();
    this.targetSessions = new Map();
    this.lastMessageAt = null;
  }

  async readBrowserWsUrl() {
    const text = await fsp.readFile(PATHS.devtools, 'utf8');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('DevToolsActivePort format invalid');
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  }

  async ensureConnected() {
    if (this.connected && this.ws) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error('Node global WebSocket is unavailable');
    }

    this.browserWsUrl = await this.readBrowserWsUrl();

    await new Promise((resolve, reject) => {
      let done = false;
      const socket = new WebSocket(this.browserWsUrl);
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        try { socket.close(); } catch {}
        reject(new Error('connect timeout'));
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = async () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.ws = socket;
        this.connected = true;
        this.lastMessageAt = nowIso();
        this.installSocketHandlers(socket);
        this.startHeartbeat();
        await this.state.update({
          connected: true,
          browserWsUrl: this.browserWsUrl,
          lastError: null,
          sessions: Object.fromEntries(this.targetSessions.entries()),
        });
        await this.logger.info('connected', { browserWsUrl: this.browserWsUrl });
        resolve();
      };

      socket.onerror = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        reject(new Error(`websocket error: ${err?.message || String(err)}`));
      };

      socket.onclose = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        reject(new Error('socket closed during connect'));
      };
    });
  }

  installSocketHandlers(socket) {
    socket.onmessage = async (event) => {
      this.lastMessageAt = nowIso();
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (err) {
        await this.logger.warn('invalid json from browser', { error: err?.message || String(err) });
        return;
      }

      if (message.method === 'Target.attachedToTarget') {
        const targetId = message.params?.targetInfo?.targetId;
        const sessionId = message.params?.sessionId;
        if (targetId && sessionId) {
          this.targetSessions.set(targetId, sessionId);
          await this.state.update({ sessions: Object.fromEntries(this.targetSessions.entries()) });
        }
      }

      if (message.method === 'Target.detachedFromTarget') {
        const detachedSessionId = message.params?.sessionId;
        for (const [targetId, sessionId] of this.targetSessions.entries()) {
          if (sessionId === detachedSessionId) this.targetSessions.delete(targetId);
        }
        await this.state.update({ sessions: Object.fromEntries(this.targetSessions.entries()) });
      }

      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? null);
      }
    };

    socket.onclose = async () => {
      if (this.ws === socket) this.ws = null;
      this.connected = false;
      this.stopHeartbeat();
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error('browser websocket closed'));
        this.pending.delete(id);
      }
      await this.state.update({ connected: false, sessions: Object.fromEntries(this.targetSessions.entries()) });
      await this.logger.warn('disconnected');
      this.scheduleReconnect();
    };

    socket.onerror = async (err) => {
      await this.logger.warn('socket error', { error: err?.message || String(err) });
    };
  }

  scheduleReconnect() {
    setTimeout(async () => {
      if (this.connected) return;
      try {
        await this.ensureConnected();
      } catch (err) {
        await this.state.update({ lastError: err?.message || String(err) });
        await this.logger.warn('reconnect failed', { error: err?.message || String(err) });
        this.scheduleReconnect();
      }
    }, 1500);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.connected) return;
      try {
        await this.send('Browser.getVersion');
      } catch (err) {
        await this.logger.warn('heartbeat failed', { error: err?.message || String(err) });
        try { this.ws?.close(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async send(method, params = {}, sessionId = null) {
    await this.ensureConnected();
    if (!this.ws || !this.connected) throw new Error('browser websocket is not connected');
    const id = this.nextMessageId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sessionId });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async getTargets() {
    const result = await this.send('Target.getTargets');
    return result?.targetInfos || [];
  }

  async findPageTarget(targetId) {
    const targets = await this.getTargets();
    if (targetId) return targets.find(t => t.targetId === targetId) || null;
    const pages = targets.filter(t => t.type === 'page');
    return pages[pages.length - 1] || null;
  }

  async ensureSession(targetId) {
    if (!targetId) throw new Error('targetId is required');
    const cached = this.targetSessions.get(targetId);
    if (cached) return cached;
    const result = await this.send('Target.attachToTarget', { targetId, flatten: true });
    if (!result?.sessionId) throw new Error(`attach failed for target ${targetId}`);
    this.targetSessions.set(targetId, result.sessionId);
    await this.state.update({ sessions: Object.fromEntries(this.targetSessions.entries()) });
    return result.sessionId;
  }
}

class CommandHandler {
  constructor(chrome, logger, state) {
    this.chrome = chrome;
    this.logger = logger;
    this.state = state;
  }

  async handle(command) {
    if (!command || typeof command !== 'object') throw new Error('command must be an object');

    if (command.type === 'raw') {
      let sessionId = command.sessionId || null;
      if (!sessionId && command.targetId && !String(command.method || '').startsWith('Target.')) {
        sessionId = await this.chrome.ensureSession(command.targetId);
      }
      const result = await this.chrome.send(command.method, command.params || {}, sessionId);
      return { ok: true, result, sessionId };
    }

    const action = command.action;
    switch (action) {
      case 'ping':
        return {
          ok: true,
          result: {
            pong: true,
            pid: process.pid,
            connected: this.chrome.connected,
            browserWsUrl: this.chrome.browserWsUrl,
            lastMessageAt: this.chrome.lastMessageAt,
          },
        };

      case 'listTargets':
        return { ok: true, result: { targetInfos: await this.chrome.getTargets() } };

      case 'newPage': {
        const result = await this.chrome.send('Target.createTarget', { url: command.url || 'about:blank' });
        return { ok: true, result };
      }

      case 'searchGoogle': {
        const q = encodeURIComponent(command.query || '');
        const result = await this.chrome.send('Target.createTarget', { url: `https://www.google.com/search?q=${q}` });
        return { ok: true, result };
      }

      case 'navigate': {
        const page = await this.chrome.findPageTarget(command.targetId);
        if (!page) throw new Error('no page target found');
        const sessionId = command.sessionId || await this.chrome.ensureSession(page.targetId);
        await this.chrome.send('Page.enable', {}, sessionId).catch(() => {});
        const result = await this.chrome.send('Page.navigate', { url: command.url }, sessionId);
        return { ok: true, result: { targetId: page.targetId, sessionId, ...result } };
      }

      case 'evaluate': {
        if (!command.expression) throw new Error('expression is required');
        const page = await this.chrome.findPageTarget(command.targetId);
        if (!page) throw new Error('no page target found');
        const sessionId = command.sessionId || await this.chrome.ensureSession(page.targetId);
        await this.chrome.send('Runtime.enable', {}, sessionId).catch(() => {});
        const result = await this.chrome.send('Runtime.evaluate', {
          expression: command.expression,
          returnByValue: command.returnByValue !== false,
          awaitPromise: command.awaitPromise !== false,
        }, sessionId);
        return { ok: true, result: { targetId: page.targetId, sessionId, ...result } };
      }

      default:
        throw new Error(`unknown action: ${action}`);
    }
  }
}

class FileQueueDaemon {
  constructor(logger, state, handler) {
    this.logger = logger;
    this.state = state;
    this.handler = handler;
    this.running = false;
    this.processing = false;
    this.processedCount = 0;
  }

  async ensureLayout() {
    await Promise.all([
      ensureDir(PATHS.inbox),
      ensureDir(PATHS.processing),
      ensureDir(PATHS.outbox),
      ensureDir(PATHS.archive),
    ]);
  }

  async listJsonFiles(dir) {
    const files = await fsp.readdir(dir).catch(() => []);
    return files.filter(name => name.endsWith('.json')).sort();
  }

  responsePathFor(requestFile) {
    const base = requestFile.replace(/\.json$/, '');
    return path.join(PATHS.outbox, `${base}.result.json`);
  }

  archivePathFor(requestFile) {
    const stamp = Date.now();
    return path.join(PATHS.archive, `${requestFile}.${stamp}`);
  }

  async claimRequest(requestFile) {
    const source = path.join(PATHS.inbox, requestFile);
    const target = path.join(PATHS.processing, requestFile);
    try {
      await fsp.rename(source, target);
      return target;
    } catch (err) {
      if (err && ['ENOENT', 'EPERM'].includes(err.code)) return null;
      throw err;
    }
  }

  async archiveProcessingFile(processingPath) {
    try {
      await fsp.rename(processingPath, this.archivePathFor(path.basename(processingPath)));
    } catch {
      try { await fsp.unlink(processingPath); } catch {}
    }
  }

  async processRequest(requestFile) {
    const existingResponse = this.responsePathFor(requestFile);
    if (await fileExists(existingResponse)) {
      const claimed = await this.claimRequest(requestFile);
      if (claimed) await this.archiveProcessingFile(claimed);
      return;
    }

    const processingPath = await this.claimRequest(requestFile);
    if (!processingPath) return;

    let requestText = null;
    let command = null;

    try {
      requestText = await fsp.readFile(processingPath, 'utf8');
      command = JSON.parse(requestText);
    } catch (err) {
      await atomicWriteJson(existingResponse, {
        requestFile,
        handledAt: nowIso(),
        ok: false,
        error: `invalid request: ${err?.message || String(err)}`,
      });
      await this.archiveProcessingFile(processingPath);
      await this.logger.warn('invalid request', { requestFile, error: err?.message || String(err) });
      return;
    }

    try {
      const response = await this.handler.handle(command);
      await atomicWriteJson(existingResponse, {
        requestFile,
        handledAt: nowIso(),
        ...response,
      });
      this.processedCount += 1;
      await this.state.update({ processedCount: this.processedCount, lastRequestFile: requestFile, lastError: null });
      await this.logger.info('handled request', { requestFile });
    } catch (err) {
      await atomicWriteJson(existingResponse, {
        requestFile,
        handledAt: nowIso(),
        ok: false,
        error: err?.message || String(err),
      });
      await this.state.update({ lastError: err?.message || String(err), lastRequestFile: requestFile });
      await this.logger.warn('request failed', { requestFile, error: err?.message || String(err) });
    } finally {
      await this.archiveProcessingFile(processingPath);
    }
  }

  async cleanupDir(dir, maxFiles) {
    const files = await this.listJsonFiles(dir);
    if (files.length <= maxFiles) return;
    const toDelete = files.slice(0, files.length - maxFiles);
    await Promise.all(toDelete.map(name => fsp.unlink(path.join(dir, name)).catch(() => {})));
  }

  async tick() {
    if (this.processing) return;
    this.processing = true;
    try {
      const files = await this.listJsonFiles(PATHS.inbox);
      for (const file of files) {
        await this.processRequest(file);
      }
      await this.cleanupDir(PATHS.outbox, MAX_OUTBOX_FILES);
      await this.cleanupDir(PATHS.archive, MAX_ARCHIVE_FILES);
    } finally {
      this.processing = false;
    }
  }

  async start() {
    await this.ensureLayout();
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        await this.state.update({ lastError: err?.message || String(err) });
        await this.logger.error('tick failed', { error: err?.message || String(err) });
      }
      await delay(SCAN_INTERVAL_MS);
    }
  }

  stop() {
    this.running = false;
  }
}

async function main() {
  const logger = new Logger(PATHS.log);
  const state = new StateStore(PATHS.state);
  const chrome = new ChromeConnection(logger, state);
  const handler = new CommandHandler(chrome, logger, state);
  const daemon = new FileQueueDaemon(logger, state, handler);

  await daemon.ensureLayout();
  await state.update({ ready: false, pid: process.pid, lastError: null });
  await chrome.ensureConnected();
  await state.update({ ready: true, connected: chrome.connected, browserWsUrl: chrome.browserWsUrl });
  await logger.info('daemon ready', { pid: process.pid });

  const shutdown = async (signal) => {
    daemon.stop();
    chrome.stopHeartbeat();
    try { chrome.ws?.close(); } catch {}
    await state.update({ ready: false, connected: false, shutdownSignal: signal });
    await logger.info('shutdown', { signal });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await daemon.start();
}

main().catch(async (err) => {
  try {
    await atomicWriteJson(PATHS.state, {
      pid: process.pid,
      updatedAt: nowIso(),
      ready: false,
      connected: false,
      lastError: err?.message || String(err),
    });
    await fsp.appendFile(PATHS.log, `[${nowIso()}] [FATAL] ${err?.stack || err?.message || String(err)}\n`).catch(() => {});
  } catch {}
  console.error(err);
  process.exit(1);
});
