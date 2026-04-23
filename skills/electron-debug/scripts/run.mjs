#!/usr/bin/env node
// Launch the Electron app via Playwright's _electron, forward main stdio,
// renderer console, pageerrors, and optionally take a screenshot.
//
// Usage: node run.mjs [--main <path>] [--duration <ms>] [--route <hash>] [--screenshot <path>]
//
// Default --main is dist-electron/main/index.js (run `npm run build` first).

import { _electron as electron } from '@playwright/test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const mainEntry = path.resolve(args.get('--main') ?? 'dist-electron/main/index.js')
const duration = Number(args.get('--duration') ?? 8000)
const route = args.get('--route')
const screenshot = args.get('--screenshot')

const out = (tag, msg) => process.stdout.write(`[${tag}] ${msg}${msg.endsWith('\n') ? '' : '\n'}`)

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

const proc = app.process()
proc.stdout?.on('data', d => out('main:out', d.toString().trimEnd()))
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

window.on('console', m => out(`renderer:${m.type()}`, m.text()))
window.on('pageerror', e => out('renderer:pageerror', `${e.message}\n${e.stack ?? ''}`))
window.on('crash', () => out('renderer:crash', 'renderer crashed'))
window.on('close', () => out('renderer:close', 'window closed'))

await window.waitForLoadState('domcontentloaded').catch(e => out('load:warn', e.message))

if (route) {
  const current = window.url()
  const next = current.replace(/#.*$/, '') + route
  await window.goto(next).catch(e => out('route:warn', e.message))
}

await new Promise(r => setTimeout(r, duration))

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
