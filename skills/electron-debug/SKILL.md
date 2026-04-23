---
name: electron-debug
description: Launch an Electron app headlessly via Playwright, forward main-process stdio + renderer console + pageerrors, optionally take a full-page screenshot, then exit. Use after changing main/preload/renderer code to verify the app boots without errors before declaring work done, or when debugging a runtime failure that only surfaces in the renderer devtools.
---

# Electron Debug Runner

## When to use

- After changing anything in the Electron **main**, **preload**, or **renderer** — before claiming the task is done.
- When the user reports a runtime error that typecheck and unit tests don't catch (renderer console errors, IPC handler throws, preload bridge missing, window failing to open).
- When you need a screenshot of the rendered UI to confirm a visual change.

Don't use this for pure logic changes already covered by unit tests — it costs a few seconds and produces noise. Unit tests first; this skill catches integration gaps tests miss.

## Prerequisites

- `@playwright/test` installed in the target project (`npm i -D @playwright/test`).
- A built main bundle at `dist-electron/main/index.js` (or wherever the project emits its main entry). If the project uses `vite-plugin-electron`, run `npm run build` first.
- The preload bundle referenced by `webPreferences.preload` in `BrowserWindow` actually exists at the referenced path (common bug: main points at `preload/index.js` but the bundler emits `preload/index.mjs`).

## How to run

One-shot: build, launch, capture everything, exit.

```bash
npm run build && node "${CLAUDE_PLUGIN_ROOT}/skills/electron-debug/scripts/run.mjs" --duration 6000
```

When running from a project where this plugin is installed, `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory. If running the script directly (local testing), use the actual path.

Output is a flat event log with prefixes you can grep:

- `[main:out] …` / `[main:err] …` — stdout/stderr from the Electron main process (launched with `ELECTRON_ENABLE_LOGGING=1`). Contains `console.log`/`console.error` from main.
- `[main:exit] code=<n> signal=<s>` — main quit. Non-zero code = crash.
- `[renderer:log|warn|error|info] …` — renderer `console.*` output.
- `[renderer:pageerror] …` — uncaught exceptions in the renderer (React render errors, IPC unwrap throws, `window.api` undefined, etc.). **These are what you're most likely looking for.**
- `[renderer:crash|close]` — renderer process died or window closed.
- `[screenshot] file:///…` — screenshot path, when `--screenshot` was passed.
- `[done]` — clean exit.

If there are no `pageerror` or `main:err` lines and `[done]` appears, the app boots clean.

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--main <path>` | `dist-electron/main/index.js` | Entry point for `_electron.launch`. Override if the project emits main elsewhere. |
| `--duration <ms>` | `8000` | How long to hold the window open before closing. Raise to 20000+ if you want to exercise interactions. |
| `--route <hash>` | (none) | Navigate to a hash route after load, e.g. `--route '#/dashboard'`. Requires the app uses `HashRouter`. |
| `--screenshot <path>` | (none) | Full-page PNG of the rendered window written to this path. Use when you need visual confirmation — then `Read` the file to view it. |

## Examples

Boot check after main-process edit:

```bash
npm run build && node "${CLAUDE_PLUGIN_ROOT}/skills/electron-debug/scripts/run.mjs" --duration 4000
```

Verify a specific route renders and capture a screenshot:

```bash
npm run build && node "${CLAUDE_PLUGIN_ROOT}/skills/electron-debug/scripts/run.mjs" \
  --route '#/dashboard' --duration 6000 --screenshot /tmp/dashboard.png
```

Non-standard main entry:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/electron-debug/scripts/run.mjs" \
  --main build/electron/main.cjs --duration 5000
```

## Interpreting output

- **`[renderer:pageerror] Cannot read properties of undefined (reading 'X')`** on `window.api.X` — the preload bridge didn't load. Check `webPreferences.preload` points at the file the bundler actually produces (often `.mjs` vs `.js` mismatch).
- **`[main:exit] code=1` before `[done]`** — main crashed on load. Look at `[main:err]` right above. Common causes:
  - A browser-only module imported into main (e.g., one that probes `window` or `document` at module top).
  - A PRNG-detecting library (`ulid`, some `uuid` variants) running at import time inside the ESM main bundle — swap for a node-`crypto`-based equivalent.
  - Missing file referenced by `loadFile`/`loadURL` — check paths relative to `__dirname` in the *built* bundle, not the source tree.
- **No `firstWindow` within 15s** — main ran but never created a `BrowserWindow`. Check init logic inside `app.whenReady()` for silent throws.
- **`[renderer:error] Failed to load resource`** — Vite dev server down, or main pointed at the wrong URL. This skill uses the built bundle, so make sure `npm run build` completed before launch.

## Cleanup

The script always calls `app.close()` before exiting, so there should be no lingering Electron processes. If one leaks (script killed with SIGKILL, machine hibernated, etc.):

```bash
pkill -f "$(pwd)/node_modules/electron"
```

## Why not `npm run dev`

Dev mode keeps running — it doesn't self-terminate, which wastes the Bash tool's timeout budget and requires careful background task management. The built bundle + Playwright's `_electron.launch` is a closed loop: launch, observe, exit. Playwright also gives structured access to renderer console/pageerrors, which you don't get by tailing `npm run dev` stdout.
