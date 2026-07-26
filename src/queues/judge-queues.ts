import { Queue } from 'bullmq'
import { getRedisConnectionOptions } from './connection.ts'

let judgeQueue: Queue | null = null

function getJudgeQueue(): Queue {
  if (!judgeQueue) judgeQueue = new Queue('job-judge', { connection: getRedisConnectionOptions() })
  return judgeQueue
}

/** Enqueues a job id discovered by the scan loop for isolated judgment. Using
 * the LinkedIn job id as BullMQ's own jobId gives free dedupe: re-enqueuing
 * the same id while it's still waiting/active in this queue is a no-op —
 * covers the same job surfacing on overlapping scan pages or repeated auto-
 * mode cycles before the judge worker has gotten to it. A LinkedIn job id is
 * always a plain numeric string, and BullMQ rejects a custom jobId that's a
 * bare integer ("Custom Id cannot be integers") — prefixed here so it's never
 * purely numeric while still uniquely deriving from the real id. */
export async function enqueueJudgeJob(jobId: string, sourceUrl: string): Promise<void> {
  const queue = getJudgeQueue()
  // Bounded retention — same reasoning as apply-queues.ts: without these every
  // completed/failed BullMQ job stays in Redis forever. The Postgres `jobs`
  // table is the durable record; Redis only needs enough history to debug
  // recent runs.
  await queue.add('judge', { jobId, sourceUrl }, { jobId: `judge-${jobId}`, removeOnComplete: 500, removeOnFail: 1000 })
}

export async function getJudgeQueueCounts(): Promise<{ waiting: number; active: number }> {
  const queue = getJudgeQueue()
  const counts = await queue.getJobCounts('waiting', 'active')
  return { waiting: counts.waiting ?? 0, active: counts.active ?? 0 }
}

/** The Queue lazily created above opens its own ioredis connection that keeps
 * the process alive on its own — a BullMQ Worker being closed does NOT close
 * the separate producer-side Queue connection. Must be called on shutdown or
 * the process hangs after /exit (only escapable via Ctrl+C) whenever a job was
 * ever enqueued or a queue count was checked that session. */
export async function closeJudgeQueues(): Promise<void> {
  await judgeQueue?.close()
  judgeQueue = null
}
