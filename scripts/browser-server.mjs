import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = parseInt(process.env.BROWSER_SERVER_PORT || '0', 10)
const HEADLESS = process.env.LAUNCH_HEADLESS === '1'
const STORAGE_STATE = process.env.STORAGE_STATE_PATH || ''
// Shared secret handed to us by the parent process. Every request must carry
// it (?token=...) — this server can navigate/close a logged-in browser, so it
// must not be drivable by any other local process or by a web page probing
// localhost ports. Refuse to start without one rather than run open.
const AUTH_TOKEN = process.env.BROWSER_SERVER_TOKEN || ''
if (!AUTH_TOKEN) {
  process.stderr.write('[browser-server] FATAL: BROWSER_SERVER_TOKEN not set\n')
  process.exit(1)
}

// Playwright's own internals occasionally race against themselves — e.g. a JS
// dialog (alert/confirm/beforeunload) that gets auto-dismissed by Playwright's
// no-listener default at the same moment the page closes it another way,
// producing an unhandled `ProtocolError: ... No dialog is showing`. Node's
// default for an unhandled rejection is to crash the process; without a
// handler here, one such internal race kills the whole browser (and every
// agent's CDP connection with it) instead of just logging and continuing.
// This subprocess only holds a browser session — surviving is strictly
// better than dying on a transient internal Playwright error.
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[browser-server] unhandled rejection (ignored, browser stays up): ${err?.stack || err}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`[browser-server] uncaught exception (ignored, browser stays up): ${err?.stack || err}\n`)
})

const PROFILE_PREFIX = 'linkedin-auto-'
const userDataDir = join(tmpdir(), `${PROFILE_PREFIX}${Date.now()}`)
process.stderr.write(`[browser-server] userDataDir: ${userDataDir}\n`)

// Each launch uses a fresh temp profile dir; login is persisted separately via
// STORAGE_STATE cookies, so old dirs are dead weight. Prune leftovers from prior
// runs at startup. Age-guarded (only dirs untouched for >1h) so a second app
// instance's just-created profile is never deleted out from under it, and we
// never touch our own current dir. Best-effort — failures are ignored.
function pruneOldProfiles() {
  const base = tmpdir()
  const cutoff = Date.now() - 60 * 60 * 1000 // 1 hour
  let removed = 0
  try {
    for (const name of readdirSync(base)) {
      if (!name.startsWith(PROFILE_PREFIX)) continue
      const full = join(base, name)
      if (full === userDataDir) continue
      try {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true })
          removed++
        }
      } catch {}
    }
  } catch {}
  if (removed > 0) process.stderr.write(`[browser-server] pruned ${removed} old profile dir(s)\n`)
}

// Remove our own profile dir. Called after the browser is closed on a clean
// shutdown, so frequent restarts don't accumulate dirs. On Windows Chromium may
// briefly hold file locks — the try/catch swallows an EBUSY and the age-based
// prune above sweeps it on a later run.
function removeOwnProfile() {
  try {
    rmSync(userDataDir, { recursive: true, force: true })
    process.stderr.write(`[browser-server] removed own profile dir\n`)
  } catch {}
}

pruneOldProfiles()

const browser = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: HEADLESS,
  args: ['--remote-debugging-port=0', '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
  noDefaultViewport: true,
})

process.stderr.write(`[browser-server] browser launched\n`)

// Find the CDP port that Chromium assigned (from --remote-debugging-port=0).
// Chromium writes the port to <userDataDir>/DevToolsActivePort after starting.
let cdpPort = null
// DevToolsActivePort is written asynchronously — poll for up to 5s.
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    const portPath = join(userDataDir, 'DevToolsActivePort')
    const content = readFileSync(portPath, 'utf-8')
    const match = content.match(/^\d+/m)
    if (match) {
      cdpPort = parseInt(match[0], 10)
      process.stderr.write(`[browser-server] CDP port: ${cdpPort}\n`)
      break
    }
  } catch {}
  await new Promise(r => setTimeout(r, 100))
}
if (!cdpPort) {
  process.stderr.write(`[browser-server] WARNING: could not find DevToolsActivePort — CDP URL will not be available\n`)
}

if (STORAGE_STATE && existsSync(STORAGE_STATE)) {
  try {
    const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8'))
    await browser.addCookies(state.cookies || [])
    process.stderr.write(`[browser-server] loaded ${state.cookies?.length || 0} cookies\n`)
  } catch(e) {
    process.stderr.write(`[browser-server] cookie load error: ${e.message}\n`)
  }
}

async function saveState() {
  if (!STORAGE_STATE) return
  try {
    mkdirSync(dirname(STORAGE_STATE), { recursive: true })
    const cookies = await browser.cookies()
    writeFileSync(STORAGE_STATE, JSON.stringify({ cookies }))
  } catch {}
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)

    if (url.searchParams.get('token') !== AUTH_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'forbidden' }))
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }

    if (url.pathname === '/navigate') {
      const target = url.searchParams.get('url')
      if (!target) { res.writeHead(400); return res.end('missing url') }
      const pages = browser.pages()
      const page = pages.length > 0 ? pages[0] : await browser.newPage()
      await page.goto(target, { waitUntil: 'domcontentloaded' })
      process.stderr.write(`[browser-server] navigated to: ${page.url()}\n`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, url: page.url() }))
    }

    if (url.pathname === '/newtab') {
      const target = url.searchParams.get('url') || 'about:blank'
      const page = await browser.newPage()
      await page.goto(target, { waitUntil: 'domcontentloaded' })
      process.stderr.write(`[browser-server] new tab: ${page.url()}\n`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }

    if (url.pathname === '/state') {
      await saveState()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }

    if (url.pathname === '/cookies') {
      // Live cookies straight from this browser's current session — unlike
      // /state, this does NOT write to STORAGE_STATE_PATH. Used to seed a
      // second, independent browser instance (see easy-apply-session.ts) with
      // whatever login this one has RIGHT NOW, without waiting for a clean
      // shutdown to persist it to disk first.
      const cookies = await browser.cookies()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ cookies }))
    }

    if (url.pathname === '/check-selector') {
      const tabIndex = parseInt(url.searchParams.get('tab') || '0', 10)
      const selector = url.searchParams.get('selector') || ''
      if (!selector) { res.writeHead(400); return res.end('missing selector') }
      const pages = browser.pages()
      if (tabIndex >= pages.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ visible: false }))
      }
      const page = pages[tabIndex]
      const visible = await page.locator(selector).first().isVisible().catch(() => false)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ visible }))
    }

    if (url.pathname === '/page-url') {
      const tabIndex = parseInt(url.searchParams.get('tab') || '0', 10)
      const pages = browser.pages()
      if (tabIndex >= pages.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ url: '' }))
      }
      const pageUrl = pages[tabIndex].url()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ url: pageUrl }))
    }

    if (url.pathname === '/cdp-url') {
      if (!cdpPort) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'CDP port not available. Ensure --remote-debugging-port was passed to Chromium.' }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}` }))
    }

    if (url.pathname === '/close') {
      process.stderr.write(`[browser-server] received /close\n`)
      await saveState()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      await browser.close()
      removeOwnProfile()
      process.stderr.write(`[browser-server] browser closed, exiting\n`)
      process.exit(0)
      return
    }

    res.writeHead(404)
    res.end('not found')
  } catch (e) {
    process.stderr.write(`[browser-server] request error: ${e.message}\n`)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address()
  const port = typeof addr === 'object' ? addr.port : PORT
  process.stderr.write(`[browser-server] listening on ${port}\n`)
  process.stdout.write(`READY:${port}\n`)
})

process.on('SIGINT', async () => {
  process.stderr.write(`[browser-server] SIGINT\n`)
  await saveState()
  await browser.close()
  removeOwnProfile()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  process.stderr.write(`[browser-server] SIGTERM\n`)
  await saveState()
  await browser.close()
  removeOwnProfile()
  process.exit(0)
})

process.on('exit', () => {
  process.stderr.write(`[browser-server] process exiting\n`)
})
