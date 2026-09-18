import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { jobContents } from '../../../src/db/schema.ts'
import { initAppState } from '../../../src/state/app-state.ts'

initAppState({ concurrency: 1, judgeConcurrency: 3, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })

const enqueueJudgeCalls: Array<{ jobId: string; sourceUrl: string }> = []

// The scrape worker's browser stack (AgentBrowser, scrape-session.ts,
// tab-guard.ts) is mocked so this file exercises processScrapeJob's own
// control flow (dedupe, retry-vs-persist, enqueue-on-success) without a real
// Chrome process — the same isolation approach judge-worker.test.ts already
// used for its DB-only assertions.
mock.module('../../../src/browser/scrape-session.ts', () => ({
  getScrapeCdpUrl: async () => 'ws://fake',
  invalidateScrapeCdpUrl: () => {},
}))
mock.module('../../../src/queues/judge-queues.ts', () => ({
  enqueueJudgeJob: async (jobId: string, sourceUrl: string) => {
    enqueueJudgeCalls.push({ jobId, sourceUrl })
  },
  // Bun's mock.module is process-global and leaks into later test files, so
  // this stub must cover every export of judge-queues.ts — judge-commands.ts
  // imports getJudgeQueueCounts from it, and a mock with only enqueueJudgeJob
  // made that import throw "Export named 'getJudgeQueueCounts' not found"
  // when the full suite ran (isolated runs passed).
  getJudgeQueueCounts: async () => ({ waiting: 0, active: 0 }),
  closeJudgeQueues: async () => {},
}))

beforeEach(() => {
  enqueueJudgeCalls.length = 0
})

afterAll(async () => {
  await closeDb()
})

const SOURCE_URL = 'https://linkedin.com/jobs/search/?keywords=engineer'

describe('processScrapeJob', () => {
  test('a job id already in job_contents skips the browser entirely and just re-enqueues for judging', async () => {
    const specifier = '../../../src/queues/scrape-worker.ts?__scrape_worker_test_dup'
    const { processScrapeJob } = await import(specifier)

    const db = getDb()
    const jobId = 'scrape-worker-test-dup'
    await db.insert(jobContents).values({ jobId, sourceUrl: SOURCE_URL, content: 'already scraped' }).onConflictDoNothing()

    await processScrapeJob(jobId, SOURCE_URL)

    expect(enqueueJudgeCalls).toEqual([{ jobId, sourceUrl: SOURCE_URL }])

    await db.delete(jobContents).where(eq(jobContents.jobId, jobId))
  })
})
