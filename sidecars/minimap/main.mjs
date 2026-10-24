import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSidecarSdk } from './sdk.mjs';
import { RuntimeUi, makeRendererSource } from '../../compat/runtime-ui.mjs';
import { platformPaths } from '../../compat/platform.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const paths = platformPaths();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const statesByCid = new Map();
let latestActiveCid = null;

function cleanPromptText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<USER_REQUEST>\s*/gi, '')
    .replace(/\s*<\/USER_REQUEST>[\s\S]*$/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function readTranscriptTurns(conversationId) {
  if (!GUID.test(conversationId || '')) return { turns: [] };
  const file = join(paths.brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const content = await readFile(file, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const turns = [];
    for (const line of lines) {
      try {
        const step = JSON.parse(line);
        if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
          const prompt = cleanPromptText(step.content || '');
          const ts = step.created_at ? Date.parse(step.created_at) : null;
          turns.push({
            turnIndex: turns.length + 1,
            startStepIndex: Number(step.step_index ?? 0),
            timestampMs: Number.isFinite(ts) ? ts : null,
            prompt: prompt || `第 ${turns.length + 1} 轮提问`,
          });
        }
      } catch {}
    }
    return { turns };
  } catch {
    return { turns: [] };
  }
}

const widgetPath = join(HERE, '..', '..', 'compat', 'minimap-widget.cjs');
const widgetCode = readFileSync(widgetPath, 'utf8');

const integration = new RuntimeUi({
  getTurns: cid => readTranscriptTurns(cid),
  onSyncState: state => {
    if (state?.conversationId && GUID.test(state.conversationId)) {
      latestActiveCid = state.conversationId;
      statesByCid.set(state.conversationId, state);
    }
  },
  source: makeRendererSource(widgetCode),
  getSource: async () => makeRendererSource(await readFile(widgetPath, 'utf8')),
  profile: paths.profile,
  dataDir: paths.data,
});

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await loadSidecarSdk();
  const app = new SidecarApp();

  app.api('/', () => new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  }), 'GET');

  const handleStateRequest = async data => {
    const rendererState = await integration.queryRendererTurns();
    if (rendererState?.conversationId && GUID.test(rendererState.conversationId)) {
      latestActiveCid = rendererState.conversationId;
      statesByCid.set(rendererState.conversationId, rendererState);
    }
    const requestedCid = GUID.test(data?.conversationId || '') ? data.conversationId : null;
    const cid = rendererState?.conversationId || latestActiveCid || requestedCid;

    const cachedState = cid ? statesByCid.get(cid) : null;
    if (cid && (!cachedState?.turns?.length)) {
      const disk = await readTranscriptTurns(cid);
      return {
        conversationId: cid,
        activeStepIndex: cachedState?.activeStepIndex ?? disk.turns.at(-1)?.startStepIndex ?? null,
        turns: disk.turns,
        health: integration.health,
      };
    }
    return {
      conversationId: cid || null,
      activeStepIndex: cachedState?.activeStepIndex ?? null,
      turns: cachedState?.turns || [],
      health: integration.health,
    };
  };

  app.api('/api/state', handleStateRequest, 'GET');
  app.api('/api/state', handleStateRequest, 'POST');

  app.api('/api/jump', async data => {
    const stepIndex = Number(data?.stepIndex);
    const cid = data?.conversationId || null;
    if (!Number.isFinite(stepIndex)) return { ok: false };
    const jumped = await integration.jumpInRenderer(stepIndex, cid);
    return { ok: jumped };
  }, 'POST');

  app.run();
  integration.start();

  const shutdown = async () => {
    await integration.stop();
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { void shutdown(); });
  }
} else {
  integration.start();
}
