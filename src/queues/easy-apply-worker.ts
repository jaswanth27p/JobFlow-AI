import { Worker, type Job } from 'bullmq'
import { and, count, eq, gte } from 'drizzle-orm'
import { getRedisConnectionOptions } from './connection.ts'
import { getApplyQueueCounts } from './apply-queues.ts'
import { processEasyApplyJob } from '../agents/easy-apply-agent.ts'
import { getDb } from '../db/index.ts'
import { applications } from '../db/schema.ts'
import { pushLog, setAgentStatus } from '../state/app-state.ts'
import type { TabId } from '../state/types.ts'

const EASY_TAB: TabId = 'easy'

let worker: Worker | null = null

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

async function appliedTodayCount(): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ n: count() })
    .from(applications)
    .where(and(eq(applications.status, 'applied'), gte(applications.createdAt, startOfToday())))
  return rows[0]?.n ?? 0
}

export function isEasyApplyWorkerRunning(): boolean {
  return worker !== null
}

/** Aborts the currently-processing job's in-flight wait (e.g. a
 * waitForNetwork pause) — mirrors judge-worker.ts's currentJobAbort. Without
 * this, a shutdown/stop request while paused offline would hang until
 * connectivity came back instead of stopping promptly. */
let currentJobAbort: AbortController | null = null

export function startEasyApplyWorker(): void {
  if (worker) return

  worker = new Worker(
    'easy-apply',
    async (job: Job<{ jobId: string }>) => {
      const [counts, appliedToday] = await Promise.all([getApplyQueueCounts(), appliedTodayCount()])
      setAgentStatus(EASY_TAB, 'running', `queue: ${counts.waiting} left, applied today: ${appliedToday}`)
      const abort = new AbortController()
      currentJobAbort = abort
      try {
        await processEasyApplyJob(job.data.jobId, abort.signal)
      } finally {
        if (currentJobAbort === abort) currentJobAbort = null
      }
    },
    { connection: getRedisConnectionOptions(), concurrency: 1 },
  )

  worker.on('failed', (_job, err) => {
    pushLog(EASY_TAB, `Worker error: ${err.message}`)
  })
  // Required: an EventEmitter with no 'error' listener throws on emit,
  // which would otherwise crash the process on a Redis connection hiccup.
  worker.on('error', (err) => {
    pushLog(EASY_TAB, `Worker connection error: ${err.message}`)
  })

  pushLog(EASY_TAB, 'Easy Apply worker started.')
  setAgentStatus(EASY_TAB, 'running', 'waiting for jobs')
}

export async function stopEasyApplyWorker(): Promise<void> {
  if (!worker) return
  // Cancel whatever job is currently in flight FIRST — worker.close() below
  // only stops the worker from picking up the NEXT job; without this it
  // would still let a job paused on waitForNetwork sit there until
  // connectivity returned on its own.
  currentJobAbort?.abort()
  await worker.close()
  worker = null
  pushLog(EASY_TAB, 'Easy Apply worker stopped.')
  setAgentStatus(EASY_TAB, 'idle', null)
}
