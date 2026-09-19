import { Queue, QueueEvents, type Job } from 'bullmq'
import { getRedisConnectionOptions } from './connection.ts'

let judgeQueue: Queue | null = null
let judgeQueueEvents: QueueEvents | null = null

function getJudgeQueue(): Queue {
  if (!judgeQueue) judgeQueue = new Queue('job-judge', { connection: getRedisConnectionOptions() })
  return judgeQueue
}

/** QueueEvents is the listener BullMQ's Job.waitUntilFinished needs to learn
 * a job reached a terminal state — a separate Redis subscriber connection
 * from the Queue/Worker. scrape-worker.ts uses this to block its own
 * processor on a specific judge job finishing (see docs/superpowers/specs/
 * 2026-09-19-single-tab-sequential-pipeline-design.md), which is what gates
 * it from pulling the next scrape job until judge (and any apply it
 * triggers) is done. */
export function getJudgeQueueEvents(): QueueEvents {
  if (!judgeQueueEvents) judgeQueueEvents = new QueueEvents('job-judge', { connection: getRedisConnectionOptions() })
  return judgeQueueEvents
}

/** Enqueues a job id discovered by the scan loop for isolated judgment. Using
 * the LinkedIn job id as BullMQ's own jobId gives free dedupe: re-enqueuing
 * the same id while it's still waiting/active in this queue is a no-op —
 * covers the same job surfacing on overlapping scan pages or repeated auto-
 * mode cycles before the judge worker has gotten to it. A LinkedIn job id is
 * always a plain numeric string, and BullMQ rejects a custom jobId that's a
 * bare integer ("Custom Id cannot be integers") — prefixed here so it's never
 * purely numeric while still uniquely deriving from the real id. Returns the
 * created Job so scrape-worker.ts can wait on it via getJudgeQueueEvents. */
export async function enqueueJudgeJob(jobId: string, sourceUrl: string): Promise<Job> {
  const queue = getJudgeQueue()
  // Bounded retention — same reasoning as apply-queues.ts: without these every
  // completed/failed BullMQ job stays in Redis forever. The Postgres `jobs`
  // table is the durable record; Redis only needs enough history to debug
  // recent runs.
  return queue.add(
    'judge',
    { jobId, sourceUrl },
    {
      jobId: `judge-${jobId}`,
      removeOnComplete: 500,
      removeOnFail: 1000,
      // Transient failures (nav timeout, a stale tab, a browser relaunch
      // race) now throw instead of silently resolving — see
      // processJudgeJob — so BullMQ needs real retry/backoff or a single
      // hiccup still drops the job on its first (only) attempt. Exponential
      // backoff (30s, 60s, 120s) gives a short blip room to clear without
      // hammering LinkedIn.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  )
}

export async function getJudgeQueueCounts(): Promise<{ waiting: number; active: number }> {
  const queue = getJudgeQueue()
  const counts = await queue.getJobCounts('waiting', 'active')
  return { waiting: counts.waiting ?? 0, active: counts.active ?? 0 }
}

/** The Queue (and now QueueEvents) lazily created above each open their own
 * ioredis connection that keeps the process alive on its own — a BullMQ
 * Worker being closed does NOT close either. Must be called on shutdown or
 * the process hangs after /exit (only escapable via Ctrl+C) whenever a job
 * was ever enqueued, a queue count was checked, or waitUntilFinished was used
 * that session. */
export async function closeJudgeQueues(): Promise<void> {
  await judgeQueue?.close()
  judgeQueue = null
  await judgeQueueEvents?.close()
  judgeQueueEvents = null
}
