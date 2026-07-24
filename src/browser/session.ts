import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { logger } from '../utils/logger.ts'
import { setSessionStatus, pushLog, TAB_IDS } from '../state/app-state.ts'

let serverPort: number | null = null
let serverProc: ReturnType<typeof Bun.spawn> | null = null
let sharedCdpUrl: string | null = null
/** Set on a deliberate shutdown, before serverProc.kill() — distinguishes an
 * expected exit from a crash for the post-startup exit watcher below. */
let shuttingDownDeliberately = false

/** Shared secret between this process and the browser-server subprocess. Every
 * request must carry it (?token=...) so a random local process or a malicious
 * web page port-scanning localhost can't drive the browser or kill it. */
const serverToken = randomUUID()

/** How long to wait for the subprocess to print READY:<port> before giving up.
 * Covers Chrome cold starts; a missing/broken `node` or Chrome install fails
 * much faster via process exit. */
const READY_TIMEOUT_MS = 60_000

// Resolve the server script relative to THIS file, not the cwd — when installed
// as an npm package the process cwd is the user's workspace, not the package.
const BROWSER_SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'browser-server.mjs')

async function ensureBrowserServer(storageStatePath: string): Promise<number> {
  if (serverPort !== null) return serverPort

  // The browser subprocess deliberately runs under Node, not Bun — Bun's copy
  // of playwright-core needs the ws patch for CDP, and Node is unaffected.
  const proc = Bun.spawn(['node', BROWSER_SERVER_SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      STORAGE_STATE_PATH: storageStatePath,
      LAUNCH_HEADLESS: '0',
      BROWSER_SERVER_TOKEN: serverToken,
    },
  })

  const stderrReader = proc.stderr.getReader()
  ;(async () => {
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await stderrReader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      logger.info(`[browser-server] ${text.trim()}`)
    }
  })()

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Browser server did not report READY within ${READY_TIMEOUT_MS / 1000}s`))
    }, READY_TIMEOUT_MS)

    // If the subprocess dies before READY (node missing, Chrome not installed,
    // playwright error), surface that as the startup error instead of hanging.
    proc.exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`Browser server exited with code ${code} before becoming ready — is Node.js and Google Chrome installed? See data/app.log for its stderr.`))
    })

    ;(async () => {
      const decoder = new TextDecoder()
      const reader = proc.stdout.getReader()
      let line = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        line += decoder.decode(value, { stream: true })
        const match = line.match(/READY:(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(parseInt(match[1]!, 10))
          return
        }
      }
    })().catch((err) => {
      clearTimeout(timer)
      reject(err)
    })
  }).catch((err) => {
    proc.kill()
    throw err
  })

  serverPort = port
  serverProc = proc

  // Post-startup crash detection. Without this, an unexpected browser-server
  // death (e.g. Chrome itself crashing) leaves serverPort/sharedCdpUrl
  // pointing at a dead endpoint — every agent tool call then fails with a
  // generic "Browser was closed externally" one at a time, with no single
  // clear signal that the whole session needs restarting. Surface it once,
  // loudly, in every tab.
  proc.exited.then((code) => {
    if (shuttingDownDeliberately) return
    if (serverProc !== proc) return // superseded by a later restart, if any
    logger.error({ code }, 'browser-server exited unexpectedly')
    serverPort = null
    serverProc = null
    sharedCdpUrl = null
    setSessionStatus('linkedin', false)
    setSessionStatus('gmail', false)
    for (const tab of TAB_IDS) {
      pushLog(
        tab,
        `The browser process crashed unexpectedly (exit code ${code}). See data/app.log for details. Restart the app to continue — /verify-login will not recover this.`,
      )
    }
  })

  return port
}

/** Appends the auth token to a browser-server path. Exported for verify-login. */
export function browserServerUrl(path: string, port = serverPort): string {
  if (port === null) throw new Error('Browser server not started')
  const sep = path.includes('?') ? '&' : '?'
  return `http://127.0.0.1:${port}${path}${sep}token=${serverToken}`
}

async function httpGet(path: string): Promise<unknown> {
  const res = await fetch(browserServerUrl(path))
  return res.json()
}

export async function launchBootstrapBrowser(storageStatePath: string): Promise<void> {
  await ensureBrowserServer(storageStatePath)
  // Fetch the CDP URL so Phase 2+ agents can attach to this same browser.
  try {
    const cdpData = await httpGet('/cdp-url') as { cdpUrl?: string }
    if (cdpData.cdpUrl) {
      sharedCdpUrl = cdpData.cdpUrl
      logger.info({ cdpUrl: sharedCdpUrl }, 'CDP URL captured for shared browser access')
      // Verify the endpoint is actually reachable NOW. agent-browser's
      // connectOverCDP swallows the real connection error and reports only a
      // generic "Failed to connect via CDP" — so probe /json/version here and
      // log the true result, otherwise the first search silently dead-ends.
      await verifyCdpReachable(sharedCdpUrl)
    } else {
      logger.error({ cdpData }, 'browser-server returned no cdpUrl — agents will not be able to attach to the browser')
    }
  } catch (err) {
    logger.warn({ err }, 'Could not fetch CDP URL — shared browser access via CDP will not be available')
  }
}

/** Probe Chromium's DevTools HTTP endpoint so a broken CDP setup fails loudly at startup instead of at first search. */
async function verifyCdpReachable(cdpUrl: string): Promise<void> {
  try {
    const res = await fetch(`${cdpUrl}/json/version`)
    const body = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (body.webSocketDebuggerUrl) {
      logger.info({ ws: body.webSocketDebuggerUrl }, 'CDP endpoint reachable (/json/version OK) — agents can attach')
    } else {
      logger.warn({ body }, 'CDP /json/version returned no webSocketDebuggerUrl — agents may fail to attach')
    }
  } catch (err) {
    logger.error(
      { err, cdpUrl },
      'CDP endpoint NOT reachable at startup — agent browsers will fail to attach. Chromium may not have opened its remote-debugging port.',
    )
  }
}

export function getSharedCdpUrl(): string {
  if (!sharedCdpUrl) throw new Error('CDP URL not available — browser may not have started yet, or --remote-debugging-port failed')
  return sharedCdpUrl
}

export function getBrowserServerPort(): number {
  if (serverPort === null) throw new Error('Browser server not started')
  return serverPort
}

export async function openLoginTabs(linkedinUrl: string, gmailUrl: string): Promise<void> {
  // tab 0: navigates the default tab the browser opens with. Allowed to
  // throw — this one's essential, nothing works without a LinkedIn tab.
  await httpGet(`/navigate?url=${encodeURIComponent(linkedinUrl)}`)
  // tab 1: a fresh tab for Gmail. Currently vestigial — no agent reads it,
  // nothing gates on it (isUnlocked() checks LinkedIn only) — kept open only
  // so /verify-login can report Gmail's login status. Best-effort: a slow or
  // failed Gmail page load (e.g. a navigation timeout) must never take the
  // whole app down before the TUI even mounts.
  try {
    await httpGet(`/newtab?url=${encodeURIComponent(gmailUrl)}`)
  } catch (err) {
    logger.warn({ err }, 'Could not open Gmail login tab — continuing without it (Gmail login is optional)')
  }
}

export async function shutdownBrowserServer(): Promise<void> {
  shuttingDownDeliberately = true
  if (serverPort !== null) {
    try {
      await fetch(browserServerUrl('/close'))
    } catch {}
  }
  if (serverProc) {
    serverProc.kill()
    serverProc = null
  }
  serverPort = null
}
