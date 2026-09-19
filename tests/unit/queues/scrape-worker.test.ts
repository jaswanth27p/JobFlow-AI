import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { jobContents } from '../../../src/db/schema.ts'
import { initAppState } from '../../../src/state/app-state.ts'

initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000 })

const enqueueJudgeCalls: Array<{ jobId: string; sourceUrl: string }> = []
const getApplyJobCalls: string[] = []
const applyWaitCalls: string[] = []
/** Swapped per test so the mocked judge job's waitUntilFinished can resolve
 * either "no apply triggered" (the default) or the apply-triggering shape the
 * second test needs — read at call time, so setting it in the test body is
 * enough (mirrors judge-worker.test.ts's module-level judgeJobResult flag). */
let judgeTriggeredApply = false

// The scrape worker's browser stack is mocked so this file exercises
// processScrapeJob's own control flow (dedupe, retry-vs-persist,
// enqueue-and-wait-on-success) without a real Chrome process — the same
// isolation approach judge-worker.test.ts already used for its DB-only
// assertions. The fake judge job resolves with triggeredApply: false by
// default (so waitForJudgeAndApply never reaches apply-queues.ts); the second
// test flips judgeTriggeredApply to true to cover the apply-wait branch.
mock.module('../../../src/browser/pipeline-tab.ts', () => ({
  getPipelineBrowser: () => ({ browser: {}, cdpUrl: 'ws://fake' }),
  ensurePipelineTab: async () => ({ matchFragment: '/jobs/view/fake' }),
}))
mock.module('../../../src/queues/judge-queues.ts', () => ({
  enqueueJudgeJob: async (jobId: string, sourceUrl: string) => {
    enqueueJudgeCalls.push({ jobId, sourceUrl })
    return {
      waitUntilFinished: async () =>
        judgeTriggeredApply ? { triggeredApply: true, applyJobId: 'fake-apply-id' } : { triggeredApply: false },
    }
  },
  // Bun's mock.module is process-global and leaks into later test files, so
  // this stub must cover every export of judge-queues.ts — judge-commands.ts
  // imports getJudgeQueueCounts from it, and a mock with only enqueueJudgeJob
  // made that import throw "Export named 'getJudgeQueueCounts' not found"
  // when the full suite ran (isolated runs passed).
  getJudgeQueueCounts: async () => ({ waiting: 0, active: 0 }),
  getJudgeQueueEvents: () => ({}),
  closeJudgeQueues: async () => {},
}))
// Complete stub (all exports) for the same process-global-leak reason above.
// getApplyJobByQueueId returns a fake apply job whose waitUntilFinished records
// the call, so the apply-wait test can assert the branch was genuinely reached.
mock.module('../../../src/queues/apply-queues.ts', () => ({
  getApplyJobByQueueId: async (queueJobId: string) => {
    getApplyJobCalls.push(queueJobId)
    return {
      waitUntilFinished: async () => {
        applyWaitCalls.push(queueJobId)
        return {}
      },
    }
  },
  getApplyQueueEvents: () => ({}),
  enqueueApplyJob: async () => ({ id: 'fake-apply-id' }),
  getApplyQueueCounts: async () => ({ waiting: 0, active: 0 }),
  closeApplyQueues: async () => {},
}))

beforeEach(() => {
  enqueueJudgeCalls.length = 0
  getApplyJobCalls.length = 0
  applyWaitCalls.length = 0
  judgeTriggeredApply = false
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

  test('a judge match also waits for the triggered apply job before resolving', async () => {
    const specifier = '../../../src/queues/scrape-worker.ts?__scrape_worker_test_apply_wait'
    const { processScrapeJob } = await import(specifier)

    const db = getDb()
    const jobId = 'scrape-worker-test-apply-wait'
    await db.insert(jobContents).values({ jobId, sourceUrl: SOURCE_URL, content: 'already scraped' }).onConflictDoNothing()
    judgeTriggeredApply = true

    await processScrapeJob(jobId, SOURCE_URL)

    expect(enqueueJudgeCalls).toEqual([{ jobId, sourceUrl: SOURCE_URL }])
    // The ordering guarantee this whole plan depends on: processScrapeJob
    // genuinely reached, looked up, and awaited the apply job (not just
    // "didn't throw").
    expect(getApplyJobCalls).toEqual(['fake-apply-id'])
    expect(applyWaitCalls).toEqual(['fake-apply-id'])

    await db.delete(jobContents).where(eq(jobContents.jobId, jobId))
  })
})
