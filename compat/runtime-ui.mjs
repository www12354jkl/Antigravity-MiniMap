import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { platformPaths } from './platform.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDING = '__agMinimapRuntimeCallV1';

export function validTarget(target, port) {
  try {
    const page = new URL(target.url), ws = new URL(target.webSocketDebuggerUrl);
    return target.type === 'page' && ['http:', 'https:'].includes(page.protocol) && LOOPBACK.has(page.hostname)
      && ws.protocol === 'ws:' && LOOPBACK.has(ws.hostname) && Number(ws.port) === port;
  } catch { return false; }
}

function jsonGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(new Error('Discovery response too large')); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Renderer discovery unavailable');
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Renderer discovery timeout')));
    req.end();
  });
}

export async function discoverTargets(profile) {
  const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  if (text.length > 1024) throw new Error('Invalid renderer discovery file');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid renderer port');
  const targets = await jsonGet(port, '/json/list');
  if (!Array.isArray(targets)) throw new Error('Invalid renderer discovery response');
  return targets.filter(target => validTarget(target, port));
}

export class CdpConnection {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeout = 5000, onEvent = () => {}, onClose = () => {} } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }
  async open() {
    this.ws = new this.WebSocketImpl(this.url);
    this.ws.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2097152) return;
        const message = JSON.parse(event.data);
        if (message.id) {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) item.reject(new Error('Renderer command failed: ' + message.error.code));
          else item.resolve(message.result || {});
        } else if (message.method) {
          this.onEvent(message);
        }
      } catch {}
    });
    this.ws.addEventListener('close', () => this.disconnect());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Renderer connection timeout')); }, this.timeout);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('Renderer connection failed')); }, { once: true });
    });
    return this;
  }
  command(method, params = {}) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('Renderer disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Renderer command timeout')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Renderer disconnected'));
    }
    this.pending.clear();
    this.onClose();
  }
  close() {
    this.disconnect();
    this.ws?.close();
  }
}

function rendererBridge(binding) {
  if (window !== window.top) return;
  if (window.__agMinimapRuntimeBridge && window.agMinimapHost) return;
  window.__agMinimapRuntimeBridge?.dispose();
  const pending = new Map();
  let sequence = 0;
  const empty = () => ({ turns: [] });
  const call = (type, input) => new Promise(resolve => {
    if (pending.size >= 8) { resolve(empty()); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); resolve(empty()); }, 10000);
    pending.set(id, { resolve, timer });
    try { window[binding](JSON.stringify({ id, type, input })); }
    catch { clearTimeout(timer); pending.delete(id); resolve(empty()); }
  });
  window.__agMinimapRuntimeBridge = {
    binding,
    resolve(id, result) {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      item.resolve(result);
    },
    dispose() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(empty());
      }
      pending.clear();
      delete window.__agMinimapRuntimeBridge;
    },
  };
  if (!window.agMinimapHost) {
    window.agMinimapHost = {
      getTranscriptTurns: input => call('turns', input),
      syncState: input => call('sync', input),
    };
  }
}

export function makeRendererSource(widgetSource) {
  const prefix = 'module.exports = ';
  const index = widgetSource.indexOf(prefix);
  if (index < 0) throw new Error('Minimap widget source format invalid');
  const extracted = widgetSource.slice(index + prefix.length).trim().replace(/;$/, '');
  const version = createHash('sha256').update(widgetSource + rendererBridge.toString()).digest('hex');
  return [
    `if(window.__agMinimapRuntimeVersion!==${JSON.stringify(version)}){`,
    `  window.__agMinimapDispose?.();`,
    `  window.__agMinimapRuntimeBridge?.dispose();`,
    `  delete window.agMinimapHost;`,
    `  window.__agMinimapRuntimeVersion=${JSON.stringify(version)};`,
    `}`,
    `(${rendererBridge.toString()})(${JSON.stringify(BINDING)});`,
    `(${extracted})();`
  ].join('');
}

export class RuntimeUi {
  constructor({
    getTurns,
    onSyncState = () => {},
    source,
    getSource = null,
    profile = platformPaths().profile,
    dataDir = platformPaths().data,
    enabled = () => true,
    discover = discoverTargets,
    interval = 2500,
  } = {}) {
    this.getTurns = getTurns;
    this.onSyncState = onSyncState;
    this.source = source;
    this.getSource = getSource;
    this.profile = profile;
    this.dataDir = dataDir;
    this.enabled = enabled;
    this.discover = discover;
    this.interval = interval;
    this.sessions = new Map();
    this.running = false;
    this.binding = BINDING;
    this.health = { state: 'waiting', mode: 'runtime', message: 'Waiting for the app renderer', windows: 0 };
  }

  async setHealth(state, message) {
    this.health = { state, mode: 'runtime', message, windows: this.sessions.size, checkedAt: new Date().toISOString() };
    if (this.dataDir) {
      try {
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(join(this.dataDir, 'integration-state.json'), JSON.stringify(this.health));
      } catch {}
    }
  }

  async event(connection, message) {
    if (this.stopping) return;
    const p = message.params || {};
    if (message.method === 'Runtime.bindingCalled' && p.name === this.binding) {
      if (typeof p.payload !== 'string' || p.payload.length > 65536) return;
      let input;
      try {
        input = JSON.parse(p.payload);
        if (!Number.isSafeInteger(input.id) || input.id < 1) return;
      } catch { return; }
      try {
        let result = {};
        if (input.type === 'turns') {
          const cid = input.input?.conversationId;
          result = GUID.test(cid || '') ? await this.getTurns(cid) : { turns: [] };
        } else if (input.type === 'sync') {
          this.onSyncState(input.input || {});
          result = { ok: true };
        }
        await connection.command('Runtime.evaluate', {
          expression: `window.__agMinimapRuntimeBridge?.resolve(${input.id}, ${JSON.stringify(result)})`,
          contextId: p.executionContextId,
        });
      } catch {
        try {
          await connection.command('Runtime.evaluate', {
            expression: `window.__agMinimapRuntimeBridge?.resolve(${input.id}, {turns:[]})`,
            contextId: p.executionContextId,
          });
        } catch {}
      }
    }
  }

  async attach(target) {
    const connection = new CdpConnection(target.webSocketDebuggerUrl, {
      onEvent: message => { void this.event(connection, message); },
    });
    connection.origin = new URL(target.url).origin;
    try {
      await connection.open();
      await connection.command('Page.enable');
      await connection.command('Runtime.enable');
      await connection.command('Runtime.addBinding', { name: this.binding });
      const guardedSource = `if (location.origin === ${JSON.stringify(connection.origin)}) { ${this.source} }`;
      connection.guardedSource = guardedSource;
      connection.script = (await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: guardedSource })).identifier;
      await connection.command('Runtime.evaluate', { expression: guardedSource });
      return connection;
    } catch (error) {
      try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
      connection.close();
      throw error;
    }
  }

  async jumpInRenderer(stepIndex, conversationId = null) {
    let jumped = false;
    for (const connection of this.sessions.values()) {
      try {
        const res = await connection.command('Runtime.evaluate', {
          returnByValue: true,
          expression: `Boolean(window.__agMinimapJumpTo?.(${Number(stepIndex)}, ${JSON.stringify(conversationId)}))`,
        });
        if (res?.result?.value === true) jumped = true;
      } catch {}
    }
    return jumped;
  }

  async queryRendererTurns() {
    for (const connection of this.sessions.values()) {
      try {
        const res = await connection.command('Runtime.evaluate', {
          returnByValue: true,
          expression: `window.__agMinimapGetState?.() || null`,
        });
        if (res?.result?.value?.conversationId) return res.result.value;
      } catch {}
    }
    return null;
  }

  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      if (!this.enabled()) {
        await this.detachAll();
        await this.setHealth('disabled', 'Conversation Minimap is disabled');
        return;
      }
      if (typeof this.getSource === 'function') {
        try {
          const nextSource = await this.getSource();
          if (nextSource && nextSource !== this.source) {
            this.source = nextSource;
            for (const connection of this.sessions.values()) {
              connection.guardedSource = `if (location.origin === ${JSON.stringify(connection.origin)}) { ${this.source} }`;
              await connection.command('Runtime.evaluate', { expression: connection.guardedSource });
            }
          }
        } catch {}
      }
      const targets = await this.discover(this.profile);
      const active = new Set(targets.map(t => t.webSocketDebuggerUrl));
      for (const [url, connection] of this.sessions) {
        if (!active.has(url) || connection.closed) {
          connection.close();
          this.sessions.delete(url);
        }
      }
      for (const target of targets) {
        if (!this.sessions.has(target.webSocketDebuggerUrl)) {
          this.sessions.set(target.webSocketDebuggerUrl, await this.attach(target));
        }
      }
      let anyMounted = false;
      for (const [url, connection] of this.sessions) {
        try {
          const result = await connection.command('Runtime.evaluate', {
            returnByValue: true,
            expression: `({
              mounted: Boolean(document.getElementById("ag-minimap-host")?.isConnected),
              installed: Boolean(window.__agMinimapInstalled),
              bridge: Boolean(window.__agMinimapRuntimeBridge && window.agMinimapHost)
            })`,
          });
          const status = result.result?.value;
          if (status?.mounted) anyMounted = true;
          if (status && (!status.installed || !status.bridge)) {
            await connection.command('Runtime.addBinding', { name: this.binding });
            await connection.command('Runtime.evaluate', { expression: connection.guardedSource });
          }
        } catch {
          try { if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script }); } catch {}
          connection.close();
          this.sessions.delete(url);
        }
      }
      await this.setHealth(
        anyMounted ? 'mounted' : this.sessions.size ? 'waiting-for-conversation' : 'waiting',
        anyMounted ? 'Minimap mounted on active conversation' : 'Connected to renderer; waiting for conversation view'
      );
    } catch {
      await this.setHealth('reconnecting', 'Renderer connection unavailable; retrying automatically.');
    } finally {
      this.busy = false;
    }
  }

  async detachAll() {
    for (const connection of this.sessions.values()) {
      try {
        await connection.command('Runtime.evaluate', {
          expression: 'window.__agMinimapDispose?.();window.__agMinimapRuntimeBridge?.dispose();delete window.agMinimapHost;',
        });
        if (connection.script) {
          await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
        }
        await connection.command('Runtime.removeBinding', { name: this.binding });
      } catch {}
      connection.close();
    }
    this.sessions.clear();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    clearInterval(this.timer);
    await this.detachAll();
  }
}
