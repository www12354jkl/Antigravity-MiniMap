#!/usr/bin/env python3
"""Management script for the Antigravity Conversation Minimap plugin."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

PLUGIN_NAME = "antigravity-minimap"
REPO_ROOT = Path(__file__).resolve().parent
PLUGIN_ITEMS = ("plugin.json", "README.md", "assets", "compat", "sidecars")


def get_plugin_dir() -> Path:
    return Path.home() / ".gemini" / "config" / "plugins" / PLUGIN_NAME


def get_sidecar_data_dir() -> Path:
    return Path.home() / ".gemini" / "antigravity" / "sidecar_data" / PLUGIN_NAME / "minimap"


def find_node() -> str:
    candidates = [
        shutil.which("node"),
        r"D:\Node.js\node.exe",
        r"C:\Program Files\nodejs\node.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise RuntimeError("Node.js executable not found.")


def ensure_ascii_agy_node_wrapper() -> None:
    """Ensure Antigravity's agy-node.cmd avoids multibyte path bugs in cmd.exe."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return
    wrapper = Path(appdata) / "Antigravity" / "bin" / "agy-node.cmd"
    if not wrapper.is_file():
        return
    try:
        content = wrapper.read_text(encoding="utf-8", errors="replace")
        # If non-ASCII characters exist in agy-node.cmd, replace with %LOCALAPPDATA% path
        if any(ord(ch) > 127 for ch in content):
            os.chmod(wrapper, 0o666)
            safe_content = (
                "@echo off\r\n"
                "set ELECTRON_RUN_AS_NODE=1\r\n"
                '"%LOCALAPPDATA%\\Programs\\antigravity\\Antigravity.exe" %*\r\n'
            )
            wrapper.write_text(safe_content, encoding="ascii")
            os.chmod(wrapper, 0o444)
    except Exception:
        pass


def copy_plugin_files(target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for item in PLUGIN_ITEMS:
        src = REPO_ROOT / item
        dst = target_dir / item
        if not src.exists():
            continue
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)


def run_live_cdp_action(action: str) -> tuple[bool, str]:
    """Inject, remove, or inspect the minimap widget in the running Antigravity Desktop app."""
    node_bin = find_node()

    script = r"""
import fs from 'node:fs';
import path from 'node:path';

const action = process.env.AG_MINIMAP_ACTION || 'status';
const widgetDir = process.env.AG_MINIMAP_WIDGET_DIR || '';
const portFile = path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');

if (!fs.existsSync(portFile)) {
  console.log(JSON.stringify({ ok: false, reason: 'DevToolsActivePort not found (is Antigravity Desktop running?)' }));
  process.exit(0);
}

const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
const port = Number(lines[0]);
if (!Number.isFinite(port) || port <= 0) {
  console.log(JSON.stringify({ ok: false, reason: 'Invalid DevTools port' }));
  process.exit(0);
}

const widgetPath = path.join(widgetDir, 'compat', 'minimap-widget.cjs');
const widgetScript = fs.readFileSync(widgetPath, 'utf8');
const runtimeUiUrl = new URL('file:///' + path.join(widgetDir, 'compat', 'runtime-ui.mjs').replace(/\\/g, '/')).href;
const { makeRendererSource } = await import(runtimeUiUrl);
const executableSource = makeRendererSource(widgetScript);

async function callCdp(wsUrl, method, params = {}) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP timeout'));
    }, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, method, params }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id === id) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
          else resolve(msg.result);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err?.error || new Error('WebSocket error'));
    };
  });
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const pages = targets.filter((t) =>
    t &&
    t.type === 'page' &&
    t.webSocketDebuggerUrl &&
    !/^devtools:\/\//i.test(String(t.url || '')) &&
    !/jetski-agent\.html/i.test(String(t.url || ''))
  );

  const results = [];
  for (const page of pages) {
    let expression = '';
    if (action === 'enable') {
      expression = `(() => {
        ${executableSource}
        return {
          mounted: Boolean(document.getElementById('ag-minimap-host')),
          installed: Boolean(window.__agMinimapInstalled),
          state: window.__agMinimapGetState?.() || null,
        };
      })()`;
    } else if (action === 'disable') {
      expression = `(() => {
        try {
          window.__agMinimapDispose?.();
        } catch {}
        try {
          document.getElementById('ag-minimap-host')?.remove();
        } catch {}
        return { mounted: Boolean(document.getElementById('ag-minimap-host')) };
      })()`;
    } else {
      expression = `(() => {
        const host = document.getElementById('ag-minimap-host');
        return {
          mounted: Boolean(host),
          installed: Boolean(window.__agMinimapInstalled),
          state: window.__agMinimapGetState?.() || null,
        };
      })()`;
    }

    const evalRes = await callCdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    results.push({
      title: page.title,
      value: evalRes?.result?.value || null,
    });
  }

  console.log(JSON.stringify({ ok: true, port, pages: results }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, reason: err?.message || String(err) }));
}
"""
    env = os.environ.copy()
    env["AG_MINIMAP_ACTION"] = action
    env["AG_MINIMAP_WIDGET_DIR"] = str(REPO_ROOT)
    proc = subprocess.run(
        [node_bin, "--input-type=module", "-"],
        input=script,
        text=True,
        encoding="utf-8",
        env=env,
        capture_output=True,
        check=False,
    )
    output = (proc.stdout or proc.stderr or "").strip()
    return proc.returncode == 0, output


def cmd_install() -> int:
    ensure_ascii_agy_node_wrapper()
    plugin_dir = get_plugin_dir()
    copy_plugin_files(plugin_dir)
    print(f"[OK] Installed plugin files to: {plugin_dir}")

    ok, out = run_live_cdp_action("enable")
    if ok:
        print(f"[OK] Live session injection result: {out}")
    else:
        print(f"[WARN] Could not live-inject into running session: {out}")
    return 0


def cmd_uninstall() -> int:
    run_live_cdp_action("disable")
    plugin_dir = get_plugin_dir()
    if plugin_dir.exists():
        shutil.rmtree(plugin_dir)
        print(f"[OK] Removed plugin directory: {plugin_dir}")
    else:
        print(f"[INFO] Plugin directory not present: {plugin_dir}")
    return 0


def cmd_enable() -> int:
    ensure_ascii_agy_node_wrapper()
    ok, out = run_live_cdp_action("enable")
    print(out)
    return 0 if ok else 1


def cmd_disable() -> int:
    ok, out = run_live_cdp_action("disable")
    print(out)
    return 0 if ok else 1


def cmd_status() -> int:
    plugin_dir = get_plugin_dir()
    sidecar_dir = get_sidecar_data_dir()
    print(f"Plugin directory: {plugin_dir} (exists={plugin_dir.exists()})")
    print(f"Sidecar data dir: {sidecar_dir} (exists={sidecar_dir.exists()})")
    ok, out = run_live_cdp_action("status")
    print(f"Live window status: {out}")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Antigravity Conversation Minimap plugin.")
    parser.add_argument(
        "command",
        choices=("install", "uninstall", "enable", "disable", "status"),
        help="Action to perform.",
    )
    args = parser.parse_args()

    dispatch = {
        "install": cmd_install,
        "uninstall": cmd_uninstall,
        "enable": cmd_enable,
        "disable": cmd_disable,
        "status": cmd_status,
    }
    return dispatch[args.command]()


if __name__ == "__main__":
    sys.exit(main())
