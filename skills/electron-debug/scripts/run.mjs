#!/usr/bin/env node
// Launch the Electron app via Playwright's _electron, forward main stdio,
// renderer console, pageerrors, intercept IPC, optionally run a scripted
// UI flow, dump an accessibility snapshot, take a screenshot, and on script
// failure drop a full diagnostic bundle to /tmp.
//
// Usage: node run.mjs [--main <path>] [--duration <ms>] [--route <hash>]
//                    [--script <path>] [--snapshot <path>]
//                    [--screenshot <path>] [--ipc off]
//
// Default --main is dist-electron/main/index.js (run `npm run build` first).

import { _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const mainEntry = path.resolve(args.get('--main') ?? 'dist-electron/main/index.js')
const duration = Number(args.get('--duration') ?? 8000)
const route = args.get('--route')
const screenshot = args.get('--screenshot')
const scriptPath = args.get('--script')
const snapshotPath = args.get('--snapshot')
const ipcOn = args.get('--ipc') !== 'off'

const BUFFER_MAX = 200
const consoleBuffer = []
const ipcBuffer = []
const pushRing = (ring, item) => {
  ring.push(item)
  if (ring.length > BUFFER_MAX) ring.shift()
}

const out = (tag, msg) => process.stdout.write(`[${tag}] ${msg}${msg.endsWith('\n') ? '' : '\n'}`)
const raw = msg => process.stdout.write(msg.endsWith('\n') ? msg : msg + '\n')

let app
try {
  app = await electron.launch({
    args: [mainEntry],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  })
} catch (e) {
  out('launch:fatal', e.stack ?? String(e))
  process.exit(1)
}

// Install IPC interception in the main process. Patches ipcMain.handle/on
// so any handler registered after this point is wrapped. Also best-effort
// retro-wraps anything already in ipcMain._invokeHandlers (Electron internal
// Map). Handlers registered synchronously at the top level of main.js before
// app.evaluate gets a chance to run may still be missed.
if (ipcOn) {
  try {
    await app.evaluate(({ ipcMain }) => {
      if (ipcMain.__patched) return
      ipcMain.__patched = true
      const log = line => process.stdout.write(line + '\n')
      const preview = v => {
        try {
          const s = JSON.stringify(v)
          return s === undefined ? String(v) : s.length > 500 ? s.slice(0, 497) + '…' : s
        } catch { return String(v) }
      }

      const origHandle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, fn) => origHandle(channel, async (event, ...a) => {
        log(`[ipc:→invoke] ${channel} ${preview(a)}`)
        try {
          const r = await fn(event, ...a)
          log(`[ipc:←invoke] ${channel} ${preview(r)}`)
          return r
        } catch (e) {
          log(`[ipc:!invoke] ${channel} ${e.message}`)
          throw e
        }
      })

      if (ipcMain._invokeHandlers && typeof ipcMain._invokeHandlers.set === 'function') {
        for (const [channel, fn] of Array.from(ipcMain._invokeHandlers.entries())) {
          ipcMain._invokeHandlers.set(channel, async (event, ...a) => {
            log(`[ipc:→invoke] ${channel} ${preview(a)}`)
            try {
              const r = await fn(event, ...a)
              log(`[ipc:←invoke] ${channel} ${preview(r)}`)
              return r
            } catch (e) {
              log(`[ipc:!invoke] ${channel} ${e.message}`)
              throw e
            }
          })
        }
      }

      const origOn = ipcMain.on.bind(ipcMain)
      ipcMain.on = (channel, fn) => origOn(channel, (event, ...a) => {
        log(`[ipc:→send] ${channel} ${preview(a)}`)
        return fn(event, ...a)
      })
    })
  } catch (e) {
    out('ipc:warn', `could not install interceptor: ${e.message}`)
  }
}

const proc = app.process()
let stdoutRemainder = ''
proc.stdout?.on('data', d => {
  const text = stdoutRemainder + d.toString()
  const lines = text.split('\n')
  stdoutRemainder = lines.pop() ?? ''
  for (const line of lines) {
    if (/^\[ipc:/.test(line)) {
      raw(line)
      pushRing(ipcBuffer, line)
    } else if (line.length > 0) {
      out('main:out', line)
    }
  }
})
proc.stderr?.on('data', d => out('main:err', d.toString().trimEnd()))
proc.on('exit', (code, signal) => out('main:exit', `code=${code} signal=${signal ?? ''}`))

let window
try {
  window = await app.firstWindow({ timeout: 15000 })
} catch (e) {
  out('window:fatal', e.message)
  await app.close().catch(() => {})
  process.exit(1)
}

window.on('console', m => {
  const line = `[renderer:${m.type()}] ${m.text()}`
  raw(line)
  pushRing(consoleBuffer, line)
})
window.on('pageerror', e => {
  const line = `[renderer:pageerror] ${e.message}\n${e.stack ?? ''}`
  raw(line)
  pushRing(consoleBuffer, line)
})
window.on('crash', () => out('renderer:crash', 'renderer crashed'))
window.on('close', () => out('renderer:close', 'window closed'))

await window.waitForLoadState('domcontentloaded').catch(e => out('load:warn', e.message))

if (route) {
  const current = window.url()
  const next = current.replace(/#.*$/, '') + route
  await window.goto(next).catch(e => out('route:warn', e.message))
}

const snapshotTree = async () => {
  try {
    return await window.accessibility.snapshot({ interestingOnly: true })
  } catch (e) {
    return { error: e.message }
  }
}

const dumpFailureBundle = async err => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(os.tmpdir(), `electron-debug-${ts}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    await window.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {})
    const tree = await snapshotTree()
    await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify(tree, null, 2))
    await fs.writeFile(path.join(dir, 'url.txt'), window.url())
    await fs.writeFile(path.join(dir, 'console.log'), consoleBuffer.join('\n'))
    await fs.writeFile(path.join(dir, 'ipc.log'), ipcBuffer.join('\n'))
    await fs.writeFile(path.join(dir, 'error.txt'), err.stack ?? String(err))
    out('failure:dump', pathToFileURL(dir).href)
  } catch (e) {
    out('failure:dump:error', e.message)
  }
}

let scriptFailed = false
if (scriptPath) {
  const resolved = path.resolve(scriptPath)
  out('script:start', resolved)
  try {
    const mod = await import(pathToFileURL(resolved).href)
    const fn = mod.default
    if (typeof fn !== 'function') {
      throw new Error(`script ${resolved} must default-export an async function`)
    }
    await fn({ app, window, snapshot: snapshotTree })
    out('script:done', 'ok')
  } catch (e) {
    scriptFailed = true
    out('script:error', e.stack ?? String(e))
    await dumpFailureBundle(e)
  }
} else {
  await new Promise(r => setTimeout(r, duration))
}

if (snapshotPath) {
  const p = path.resolve(snapshotPath)
  try {
    const tree = await snapshotTree()
    await fs.writeFile(p, JSON.stringify(tree, null, 2))
    out('snapshot', pathToFileURL(p).href)
  } catch (e) {
    out('snapshot:error', e.message)
  }
}

if (screenshot) {
  const p = path.resolve(screenshot)
  try {
    await window.screenshot({ path: p, fullPage: true })
    out('screenshot', pathToFileURL(p).href)
  } catch (e) {
    out('screenshot:error', e.message)
  }
}

await app.close().catch(() => {})
out('done', 'closed cleanly')
if (scriptFailed) process.exit(1)
