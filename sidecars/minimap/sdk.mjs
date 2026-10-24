import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { installedAgentExecutable, platformPaths } from '../../compat/platform.mjs';

export async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    try {
      const file = createRequire(import.meta.url).resolve('sidecar_sdk');
      return import(pathToFileURL(file).href);
    } catch (resolveError) {
      if (resolveError.code !== 'MODULE_NOT_FOUND') throw resolveError;
      return loadBundledSdk();
    }
  }
}

const hash = value => createHash('sha256').update(value).digest('hex');

function extractBundledSdk(binary) {
  const marker = binary.indexOf('export class SidecarApp');
  const start = binary.lastIndexOf("import { execFileSync } from 'node:child_process';", marker);
  const tail = "return provided === this.#token;\n  }\n}\n";
  const tailIndex = binary.indexOf(tail, marker);
  const preloadMarker = binary.indexOf('window.sidecar =');
  const preloadStart = binary.lastIndexOf('(function() {', preloadMarker);
  const preloadTail = '\n})();';
  const preloadEnd = binary.indexOf(preloadTail, preloadMarker);
  if (marker < 0 || start < 0 || tailIndex < marker || preloadStart < 0 || preloadEnd < preloadMarker) {
    throw new Error('Incompatible Sidecar SDK format in language_server binary');
  }
  const sdk = binary.subarray(start, tailIndex + Buffer.byteLength(tail)).toString('utf8');
  const preload = binary.subarray(preloadStart, preloadEnd + Buffer.byteLength(preloadTail)).toString('utf8');
  return { sdk, preload };
}

async function loadBundledSdk() {
  const exe = installedAgentExecutable();
  const directory = join(platformPaths().data, 'sdk');
  const info = await stat(exe);
  const stamp = `v1:${exe}:${info.size}:${info.mtimeMs}`;
  const root = join(directory, hash(stamp));
  const indexFile = join(root, 'index.mjs');
  try {
    await stat(indexFile);
  } catch {
    const resources = extractBundledSdk(await readFile(exe));
    await mkdir(root, { recursive: true });
    await writeFile(indexFile, resources.sdk, 'utf8');
    await writeFile(join(root, 'preload.js'), resources.preload, 'utf8');
  }
  return import(pathToFileURL(indexFile).href);
}
