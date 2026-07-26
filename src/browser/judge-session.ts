import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { logger } from '../utils/logger.ts'
import { browserServerUrl as bootstrapServerUrl, getBrowserServerPort as getBootstrapPort } from './session.ts'

/**
 * A THIRD, fully independent Chrome process dedicated to the judge-queue
 * worker — separate from both the bootstrap browser (session.ts, shared by
 * search/career-scan) and the easy-apply browser (easy-apply-session.ts).
 * The judge worker opens/closes a job's detail-page tab for every single
 * queued job, continuously, independent of whatever the scan loop or the
 * easy-apply worker are doing at the same moment — giving it its own browser
 * removes any tab-contention with either of them, same reasoning as
 * easy-apply-session.ts's split from the bootstrap browser.
 *
 * Logged into LinkedIn automatically by copying LIVE cookies from the
 * already-running bootstrap browser at the moment this browser launches (via
 * the bootstrap browser-server's /cookies endpoint) — not the on-disk
 * browser-storage-state.json snapshot, which is only written on a clean app
 * shutdown (see saveState() in scripts/browser-server.mjs) and would miss a
 * login the user just did this session. No second manual login step.
 *
 * Lazily launched on first use (see getJudgeCdpUrl, called from
 * judge-worker.ts) rather than at app startup, so a session that never
 * starts the judge queue worker never opens a third visible Chrome window.
 */

const READY_TIMEOUT_MS = 60_000
const BROWSER_SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'browser-server.mjs')
const STORAGE_STATE_PATH = './data/judge-browser-storage-state.json'

let serverPort: number | null = null
let serverProc: ReturnType<typeof Bun.spawn> | null = null
let cdpUrl: string | null = null
let launching: Promise<string> | null = null
let shuttingDownDeliberately = false

const serverToken = randomUUID()

function serverUrl(path: string, port: number): string {
  const sep = path.includes('?') ? '&' : '?'
  return `http://127.0.0.1:${port}${path}${sep}token=${serverToken}`
}

/** Snapshots the bootstrap browser's LIVE cookies (not the on-disk file — see
 * module doc) into this browser's own storage-state file, which
 * browser-server.mjs reads at launch. Best-effort: if the bootstrap browser
 * isn't up yet or the fetch fails, the judge browser still launches — it'll
 * just start logged out, same as any fresh browser would. */
async function seedCookiesFromBootstrap(): Promise<void> {
  try {
    const port = getBootstrapPort()
    const res = await fetch(bootstrapServerUrl('/cookies', port))
    const body = (await res.json()) as { cookies?: unknown }
    await mkdir(dirname(STORAGE_STATE_PATH), { recursive: true })
    await writeFile(STORAGE_STATE_PATH, JSON.stringify({ cookies: body.cookies ?? [] }))
  } catch (err) {
    logger.warn({ err }, 'judge browser: could not copy live cookies from the bootstrap browser — starting logged out')
  }
}

async function spawnAndWaitReady(): Promise<number> {
  const proc = Bun.spawn(['node', BROWSER_SERVER_SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      STORAGE_STATE_PATH,
      LAUNCH_HEADLESS: '0',
      BROWSER_SERVER_TOKEN: serverToken,
    },
  })

  const stderrReader = proc.stderr.getReader()
  void (async () => {
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await stderrReader.read()
      if (done) break
      logger.info(`[judge-browser-server] ${decoder.decode(value, { stream: true }).trim()}`)
    }
  })()

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Judge browser server did not report READY within ${READY_TIMEOUT_MS / 1000}s`))
    }, READY_TIMEOUT_MS)

    proc.exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`Judge browser server exited with code ${code} before becoming ready.`))
    })

    void (async () => {
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

  serverProc = proc
  serverPort = port

  // Same crash-detection intent as session.ts/easy-apply-session.ts, scoped to
  // this one — a dead judge browser should fail loudly on the NEXT job rather
  // than hang.
  proc.exited.then((code) => {
    if (shuttingDownDeliberately) return
    if (serverProc !== proc) return
    logger.error({ code }, 'judge browser-server exited unexpectedly')
    serverPort = null
    serverProc = null
    cdpUrl = null
    launching = null
  })

  return port
}

async function fetchCdpUrl(port: number): Promise<string> {
  const res = await fetch(serverUrl('/cdp-url', port))
  const body = (await res.json()) as { cdpUrl?: string }
  if (!body.cdpUrl) throw new Error('judge browser-server returned no cdpUrl')
  return body.cdpUrl
}

/** Launches the judge browser on first call, reusing the same instance on
 * every later call. */
export async function getJudgeCdpUrl(): Promise<string> {
  if (cdpUrl) return cdpUrl
  if (!launching) {
    launching = (async () => {
      await seedCookiesFromBootstrap()
      const port = await spawnAndWaitReady()
      const url = await fetchCdpUrl(port)
      cdpUrl = url
      logger.info({ cdpUrl: url }, 'judge browser: launched and CDP reachable')
      return url
    })().catch((err) => {
      launching = null
      throw err
    })
  }
  return launching
}

export function isJudgeBrowserRunning(): boolean {
  return serverPort !== null
}

export async function shutdownJudgeBrowser(): Promise<void> {
  shuttingDownDeliberately = true
  if (serverPort !== null) {
    try {
      await fetch(serverUrl('/close', serverPort))
    } catch {
      // Best-effort — proc.kill() below is the fallback.
    }
  }
  if (serverProc) {
    serverProc.kill()
    serverProc = null
  }
  serverPort = null
  cdpUrl = null
  launching = null
}
