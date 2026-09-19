import { Queue, QueueEvents, type Job } from 'bullmq'
import { getRedisConnectionOptions } from './connection.ts'

let easyQueue: Queue | null = null
let easyQueueEvents: QueueEvents | null = null

function getEasyQueue(): Queue {
  if (!easyQueue) easyQueue = new Queue('easy-apply', { connection: getRedisConnectionOptions() })
  return easyQueue
}

/** See judge-queues.ts's getJudgeQueueEvents — same reasoning: a separate
 * Redis subscriber connection scrape-worker.ts uses to block on the specific
 * apply job a judge match just triggered, before it resumes scraping. */
export function getApplyQueueEvents(): QueueEvents {
  if (!easyQueueEvents) easyQueueEvents = new QueueEvents('easy-apply', { connection: getRedisConnectionOptions() })
  return easyQueueEvents
}

/** No custom jobId here (unlike scrape-/judge-queues.ts) — retry.ts's
 * /retry-failed-applications re-enqueues the same LinkedIn job id after a
 * failure, and a deterministic id would make that re-add collide with (and
 * silently no-op against) the old failed BullMQ record instead of actually
 * re-running it. Returns the created Job — judge-worker.ts's
 * recordJudgeVerdict hands its id back up through processJudgeJob's return
 * value so scrape-worker.ts can look it up via getApplyJobByQueueId. */
export async function enqueueApplyJob(jobId: string): Promise<Job> {
  const queue = getEasyQueue()
  // Bounded retention: without these, every completed/failed BullMQ job stays
  // in Redis forever and the instance grows without limit. The Postgres
  // `applications` table is the durable record; Redis only needs enough
  // history to debug recent runs.
  return queue.add('apply', { jobId }, { removeOnComplete: 500, removeOnFail: 1000 })
}

/** Looks up an enqueued apply job by its own BullMQ queue id (NOT the
 * LinkedIn job id — see enqueueApplyJob's note on why this queue has no
 * deterministic jobId). Used by scrape-worker.ts to wait on the specific apply
 * job a judge verdict's return value just told it about. */
export async function getApplyJobByQueueId(queueJobId: string): Promise<Job | undefined> {
  const queue = getEasyQueue()
  return queue.getJob(queueJobId)
}

export async function getApplyQueueCounts(): Promise<{ waiting: number; active: number }> {
  const queue = getEasyQueue()
  const counts = await queue.getJobCounts('waiting', 'active')
  return { waiting: counts.waiting ?? 0, active: counts.active ?? 0 }
}

/** The Queue (and now QueueEvents) lazily created above each open their own
 * ioredis connection that keeps the process alive on its own — a BullMQ
 * Worker being closed does NOT close either. Must be called on shutdown or
 * the process hangs after /exit (only escapable via Ctrl+C) whenever a job
 * was ever enqueued, a queue count was checked, or waitUntilFinished was used
 * that session. */
export async function closeApplyQueues(): Promise<void> {
  await easyQueue?.close()
  easyQueue = null
  await easyQueueEvents?.close()
  easyQueueEvents = null
}
