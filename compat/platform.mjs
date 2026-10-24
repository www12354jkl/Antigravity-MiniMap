import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export function platformPaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  let config, local;
  if (platform === 'win32') {
    config = env.APPDATA || join(home, 'AppData', 'Roaming');
    local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    config = local = join(home, 'Library', 'Application Support');
  } else {
    config = env.XDG_CONFIG_HOME || join(home, '.config');
    local = env.XDG_DATA_HOME || join(home, '.local', 'share');
  }
  const profile = env.AG_MINIMAP_PROFILE || join(config, 'Antigravity');
  const brainDir = join(home, '.gemini', 'antigravity', 'brain');
  const data = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(home, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-minimap', 'minimap', 'data');
  return {
    home,
    config,
    local,
    profile,
    brainDir,
    data,
    pluginConfig: join(home, '.gemini', 'config', 'config.json'),
  };
}

export function installedAgentExecutable({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (env.ANTIGRAVITY_AGENTAPI_EXE && existsSync(env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return env.ANTIGRAVITY_AGENTAPI_EXE;
  }
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = platform === 'win32'
    ? [join(local, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe')]
    : platform === 'darwin'
      ? ['/Applications/Antigravity.app/Contents/Resources/bin/language_server', join(home, 'Applications/Antigravity.app/Contents/Resources/bin/language_server')]
      : ['/opt/Antigravity/resources/bin/language_server', '/usr/share/antigravity/resources/bin/language_server'];
  const found = candidates.find(c => existsSync(c));
  if (!found) throw new Error('Bundled language_server executable not found.');
  return found;
}
