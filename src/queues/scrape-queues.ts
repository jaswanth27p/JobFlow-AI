import { Queue } from 'bullmq'
import { getRedisConnectionOptions } from './connection.ts'

let scrapeQueue: Queue | null = null

function getScrapeQueue(): Queue {
  if (!scrapeQueue) scrapeQueue = new Queue('job-scrape', { connection: getRedisConnectionOptions() })
  return scrapeQueue
}

/** Enqueues a job id discovered by the scan loop for content acquisition.
 * Uses the LinkedIn job id as BullMQ's own jobId for free dedupe — the same
 * reasoning as judge-queues.ts's enqueueJudgeJob, prefixed so it's never a
 * bare integer (BullMQ rejects those as a custom jobId). */
export async function enqueueScrapeJob(jobId: string, sourceUrl: string): Promise<void> {
  const queue = getScrapeQueue()
  await queue.add(
    'scrape',
    { jobId, sourceUrl },
    {
      jobId: `scrape-${jobId}`,
      removeOnComplete: 500,
      removeOnFail: 1000,
      // A transient nav/read failure throws (see scrape-worker.ts) so BullMQ
      // needs real retry/backoff, same reasoning as judge-queues.ts.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  )
}

export async function getScrapeQueueCounts(): Promise<{ waiting: number; active: number; delayed: number }> {
  const queue = getScrapeQueue()
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed')
  return { waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0 }
}

/** Must be called on shutdown — see judge-queues.ts's closeJudgeQueues for
 * why (a lazily-created Queue keeps its own ioredis connection alive). */
export async function closeScrapeQueues(): Promise<void> {
  await scrapeQueue?.close()
  scrapeQueue = null
}
