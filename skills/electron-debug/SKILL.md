---
name: electron-debug
description: Launch an Electron app headlessly via Playwright, forward main-process stdio + renderer console + pageerrors, intercept IPC calls between renderer and main, optionally run a scripted UI flow (click buttons, fill inputs, assert state), dump an accessibility snapshot to discover selectors, take a screenshot, and on script failure drop a full diagnostic bundle (screenshot + DOM + URL + console + IPC). Use after changing main/preload/renderer code to verify the app boots without errors, when debugging a runtime failure that only surfaces in the renderer devtools, or when you need to exercise a user flow end-to-end.
---

# Electron Debug Runner

## When to use

- **Boot check** — after changing anything in the Electron **main**, **preload**, or **renderer**, before claiming the task is done.
- **Runtime bug hunt** — when the user reports an error that typecheck and unit tests don't catch (renderer console errors, IPC handler throws, preload bridge missing, window failing to open).
- **Visual confirmation** — when you need a screenshot of the rendered UI to confirm a visual change.
- **Scripted UI flow** — when you need to click buttons, fill inputs, navigate, and assert on DOM state to verify a feature works end-to-end. Pass `--script <file>` with a Playwright action module (see below).

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
- `[snapshot] file:///…` — accessibility-tree JSON path, when `--snapshot` was passed.
- `[ipc:→invoke|←invoke|!invoke|→send] <channel> <payload>` — IPC traffic crossing the renderer↔main boundary (see "IPC interception" below).
- `[script:start|done|error] …` — lifecycle of a `--script` run. `[script:error]` includes the stack; the runner still closes the app cleanly and then exits non-zero.
- `[failure:dump] file:///…` — on script failure, path to a directory with screenshot, DOM snapshot, URL, console/IPC buffers, and the error stack.
- `[done]` — clean exit.

If there are no `pageerror` or `main:err` lines and `[done]` appears, the app boots clean.

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--main <path>` | `dist-electron/main/index.js` | Entry point for `_electron.launch`. Override if the project emits main elsewhere. |
| `--duration <ms>` | `8000` | How long to hold the window open before closing. Ignored when `--script` is passed — the script controls timing. |
| `--route <hash>` | (none) | Navigate to a hash route after load, e.g. `--route '#/dashboard'`. Requires the app uses `HashRouter`. |
| `--script <path>` | (none) | ES module that default-exports `async ({ app, window, snapshot }) => { … }`. Runs after load/routing, before screenshot. See "Scripted interaction" below. |
| `--snapshot <path>` | (none) | Dump the renderer's accessibility tree (as JSON) to this path. Use to discover real selectors instead of guessing. |
| `--screenshot <path>` | (none) | Full-page PNG of the rendered window written to this path. Use when you need visual confirmation — then `Read` the file to view it. |
| `--ipc off` | `on` | Disable IPC interception. Default is on — patches `ipcMain.handle`/`.on` to emit `[ipc:…]` events. Turn off if your app does exotic things with `ipcMain` internals. |

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

Exercise a login flow and screenshot the result:

```bash
npm run build && node "${CLAUDE_PLUGIN_ROOT}/skills/electron-debug/scripts/run.mjs" \
  --script ./tmp/login-flow.mjs --screenshot /tmp/after-login.png
```

## Scripted interaction

When you need to drive the UI — click buttons, fill inputs, assert state — write a small ES module and pass it with `--script`. The runner default-imports it and calls it with `{ app, window }`:

- `window` is a Playwright [`Page`](https://playwright.dev/docs/api/class-page) pointed at the renderer. Full locator/click/fill/keyboard/assert API.
- `app` is the Playwright [`ElectronApplication`](https://playwright.dev/docs/api/class-electronapplication). Use `app.evaluate(({ BrowserWindow }) => …)` to poke the main process.

Example — `tmp/login-flow.mjs`:

```js
export default async ({ window, snapshot }) => {
  await window.locator('input[name=email]').fill('test@example.com')
  await window.locator('input[name=password]').fill('hunter2')
  await window.locator('button:has-text("Sign in")').click()
  await window.waitForSelector('[data-testid=dashboard]', { timeout: 5000 })
  console.log('[step] reached dashboard')
  // Optional: inspect what's on screen without writing selectors blind.
  const tree = await snapshot()
  console.log('[step] visible roles:', tree.children?.map(c => c.role).join(','))
}
```

The script context also gets `snapshot()` — an async helper returning the renderer's accessibility tree (`{role, name, value, children, …}`). Use it to discover real selectors before writing them, or to assert structure at runtime.

Throw to fail the run — the error lands in `[script:error]` with a stack, a full diagnostic bundle is written to `/tmp/electron-debug-<ts>/` (see "Failure dumps"), the app closes cleanly, and the process exits `1`. Use `console.log` for step-by-step progress; it shows up inline with the other `[…]` tags so you can grep it.

Tips:

- Prefer `data-testid` selectors over text/CSS — they survive copy changes and refactors. If you don't know what's there, call `snapshot()` first (or run once with `--snapshot /tmp/tree.json`).
- Wrap waits with explicit timeouts (`{ timeout: 5000 }`) so failures fail fast instead of hanging to Playwright's 30s default.
- Don't `await app.close()` inside your script — the runner does it after the script returns.

## Accessibility snapshots

Selectors are the #1 source of flaky, guessed-at UI scripts. To avoid guessing, dump the renderer's accessibility tree once and write selectors against what's actually there:

```bash
npm run build && node "${CLAUDE_PLUGIN_ROOT}/skills/electron-debug/scripts/run.mjs" \
  --snapshot /tmp/tree.json --duration 3000
```

Then `Read` `/tmp/tree.json` to see the structure. Each node has `{role, name, value, children, …}` — pick nodes by role + name rather than CSS. Inside a script, the same data is available as `await snapshot()`.

## IPC interception

On by default. Shortly after launch, the runner patches `ipcMain.handle` and `ipcMain.on` in the main process so every IPC crossing the renderer↔main boundary is logged:

- `[ipc:→invoke] <channel> <args>` — renderer called `ipcRenderer.invoke(channel, …args)`.
- `[ipc:←invoke] <channel> <result>` — main handler returned (truncated to 500 chars).
- `[ipc:!invoke] <channel> <message>` — main handler threw.
- `[ipc:→send] <channel> <args>` — renderer called `ipcRenderer.send(channel, …args)`.

This turns "why is nothing happening when I click Save?" into a straightforward grep: see whether the IPC fired, whether main received it, and what it returned.

Limitations:

- Handlers registered *synchronously at the top of main.js* (before the runner's post-launch `app.evaluate` runs) are best-effort wrapped via `ipcMain._invokeHandlers` (an Electron internal). Most apps register inside `app.whenReady()` and are fully covered.
- Renderer→renderer postMessage isn't IPC and isn't captured.
- Pass `--ipc off` if the interceptor conflicts with exotic `ipcMain` usage.

## Failure dumps

When a `--script` run throws, the runner writes a timestamped directory under `/tmp/` containing:

| File | Contents |
|---|---|
| `screenshot.png` | Full-page PNG at the moment of failure. |
| `snapshot.json` | Accessibility tree at the moment of failure — for fixing selectors. |
| `url.txt` | Current renderer URL. |
| `console.log` | Last 200 renderer console events + pageerrors. |
| `ipc.log` | Last 200 IPC events from the interceptor. |
| `error.txt` | The script's thrown error and stack. |

The path is printed as `[failure:dump] file:///…` — open it with `Read` (PNG, JSON) or your usual viewer to diagnose and fix the script in one pass instead of rerunning to re-gather context.

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
