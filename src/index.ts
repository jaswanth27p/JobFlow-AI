import { ensureDataDir, createLogger, logger } from './utils/logger.ts'
import { loadConfig } from './config/loader.ts'
import { setCurrentConfig } from './config/current.ts'
import { loadResume, loadProfile } from './profile/loader.ts'
import { getDb, closeDb } from './db/index.ts'
import { launchBootstrapBrowser, openLoginTabs, shutdownBrowserServer } from './browser/session.ts'
import { shutdownEasyApplyBrowser } from './browser/easy-apply-session.ts'
import { startLoginAutoVerify, stopLoginAutoVerify } from './browser/verify-login.ts'
import { initAppState } from './state/app-state.ts'
import { registerBuiltinCommands } from './commands/index.ts'
import { stopSearchAndWait } from './agents/search-agent.ts'
import { stopAutoModeAndWait } from './agents/search-scheduler.ts'
import { stopCareerCheckAndWait } from './agents/career-scan-agent.ts'
import { stopEasyApplyWorker } from './queues/easy-apply-worker.ts'
import { closeApplyQueues, getApplyQueueCounts } from './queues/apply-queues.ts'
import { startDashboard, stopDashboard } from './dashboard/server.ts'
import { startSummaryScheduler, stopSummaryScheduler } from './notify/summary-aggregator.ts'
import { mountTui, destroyTui } from './tui/index.tsx'

// Last-resort safety net: opentui owns the terminal once the TUI is mounted,
// so ANY raw stdout/stderr write (which is exactly what Node's default
// unhandled-rejection/exception handler does) lands on top of its frame,
// outside opentui's own text buffer — unreadable and uncopyable, since it's
// not part of what the TUI's own selection/scrollback can see. Route these
// through the file-only logger instead. Does not exit the process — an
// unexpected rejection from, say, a stray background fetch shouldn't kill an
// otherwise-fine session; data/app.log is where to look afterward.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection')
})
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception')
})

let shuttingDown = false

async function cleanup() {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('Shutting down...')
  destroyTui()
  stopDashboard()
  stopSummaryScheduler()
  stopLoginAutoVerify()
  // Stop all agents/processes in dependency order: the search agent first
  // (it's driving the browser directly, no queue to gate it), then the
  // easy-apply queue worker (its open Redis connection keeps the process
  // alive indefinitely otherwise), and only once nothing is using the
  // browser anymore do we kill it.
  await stopAutoModeAndWait()
  await stopSearchAndWait()
  await stopCareerCheckAndWait()
  await stopEasyApplyWorker()
  await closeApplyQueues()
  // easy-apply's own dedicated browser (see easy-apply-session.ts) — a no-op
  // if it was never launched this session (lazy, only on first easy-apply use).
  await shutdownEasyApplyBrowser()
  await shutdownBrowserServer()
  await closeDb()
}

async function main() {
  ensureDataDir()
  createLogger()

  const config = await loadConfig()
  setCurrentConfig(config)

  await loadResume(config.profileFiles.resume)
  await loadProfile(config.profileFiles.profile)

  // Fail fast, before the TUI takes over the terminal, if Postgres is
  // unreachable — a plain SELECT 1, since schema setup is still the user's
  // own `bun run db:push` step (see README), not done here.
  try {
    await getDb().execute('select 1')
  } catch (err) {
    logger.error({ err }, 'database not ready')
    console.error(
      `Could not connect to Postgres (DATABASE_URL=${process.env.DATABASE_URL ?? '(unset)'}).\n` +
        'Is the database running? Start it with: docker compose up -d\n' +
        'Has the schema been pushed? Run: bun run db:push\n' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  // Same fail-fast for Redis — ioredis retries forever by default, so a down
  // Redis otherwise shows up as a silent hang the first time a job is queued.
  try {
    await Promise.race([
      getApplyQueueCounts(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 5s')), 5000)),
    ])
  } catch (err) {
    logger.error({ err }, 'redis not ready')
    console.error(
      `Could not reach Redis (REDIS_URL=${process.env.REDIS_URL ?? '(unset)'}).\n` +
        'Is Redis running? Start it with: docker compose up -d\n' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  startDashboard()
  startSummaryScheduler(config.notifySummaryIntervalMinutes * 60_000)

  initAppState({
    concurrency: config.concurrency,
    model: config.model,
    minNavDelayMs: config.search.minNavDelayMs,
    maxNavDelayMs: config.search.maxNavDelayMs,
    loopCooldownMs: config.search.loopCooldownMs,
  })

  registerBuiltinCommands()

  await launchBootstrapBrowser('./data/browser-storage-state.json')
  await openLoginTabs('https://www.linkedin.com/login', 'https://mail.google.com/mail/')

  // Restored cookies usually mean we're already logged in — poll every 5s and
  // flip the session to unlocked automatically, so the user doesn't have to run
  // /verify-login by hand. Stops itself on the first success.
  startLoginAutoVerify(5000)

  process.on('SIGTERM', () => { cleanup().then(() => process.exit(0)) })
  process.on('SIGINT', () => { cleanup().then(() => process.exit(0)) })

  try {
    logger.info('Starting TUI...')
    await mountTui()
    logger.info('TUI exited normally')
  } catch (err) {
    logger.error({ err }, 'TUI crashed')
    throw err
  }

  await cleanup()
}

main().catch(async (err) => {
  logger.error(err)
  await cleanup()
  console.error(err)
  process.exit(1)
})
