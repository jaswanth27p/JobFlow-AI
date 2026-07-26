import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { jobs } from '../../../src/db/schema.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'
import { processJudgeJob, recordJudgeVerdict } from '../../../src/queues/judge-worker.ts'
import type { JobJudgeVerdict } from '../../../src/agents/job-relevance-judge.ts'

initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })

// enqueueApplyJob (apply-queues.ts) opens a real ioredis connection as a side
// effect of module load / first call — mocked out so this file's DB-only
// assertions don't require Redis. recordExternalJobFound is a module-level
// counter (summary-aggregator.ts) shared process-wide across test files, same
// reasoning as easy-apply-agent.test.ts's mock of it.
beforeEach(() => {
  mock.module('../../../src/queues/apply-queues.ts', () => ({ enqueueApplyJob: async () => {} }))
  mock.module('../../../src/notify/summary-aggregator.ts', () => ({ recordExternalJobFound: () => {} }))
})

afterAll(async () => {
  const applyQueuesSpecifier = '../../../src/queues/apply-queues.ts?__restore_real_judge_worker_test'
  const applyQueuesReal = await import(applyQueuesSpecifier)
  mock.module('../../../src/queues/apply-queues.ts', () => ({ ...applyQueuesReal }))

  const summarySpecifier = '../../../src/notify/summary-aggregator.ts?__restore_real_judge_worker_test'
  const summaryReal = await import(summarySpecifier)
  mock.module('../../../src/notify/summary-aggregator.ts', () => ({ ...summaryReal }))

  await closeDb()
})

const SOURCE_URL = 'https://linkedin.com/jobs/search/?keywords=engineer'

describe('processJudgeJob', () => {
  test('skips a job id already recorded — duplicate delivery is a no-op', async () => {
    const db = getDb()
    await db
      .insert(jobs)
      .values({
        id: 'judge-worker-test-dup',
        title: 'Senior Engineer',
        company: 'Acme',
        applyUrl: 'https://linkedin.com/jobs/view/1',
        applyType: 'easy',
        sourceUrl: SOURCE_URL,
        status: 'queued',
      })
      .onConflictDoNothing()

    await processJudgeJob('judge-worker-test-dup', SOURCE_URL)
    expect(appState.tabs.judge.logs.some((l) => l.includes('already recorded'))).toBe(true)

    await db.delete(jobs).where(eq(jobs.id, 'judge-worker-test-dup'))
  })
})

describe('recordJudgeVerdict', () => {
  test('a skip verdict is recorded with status skipped and not routed anywhere', async () => {
    const db = getDb()
    const jobId = 'judge-worker-test-skip'
    const verdict: JobJudgeVerdict = {
      title: 'Backend Engineer',
      company: 'Widgets Inc',
      location: 'Remote',
      applyType: 'external',
      externalUrl: null,
      verdict: 'skip',
      reason: 'Requires 5+ years, candidate has 2.',
    }

    await recordJudgeVerdict(jobId, SOURCE_URL, 'https://linkedin.com/jobs/view/2', verdict)

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('skipped')

    await db.delete(jobs).where(eq(jobs.id, jobId))
  })

  test('an easy-apply verdict is recorded as queued', async () => {
    const db = getDb()
    const jobId = 'judge-worker-test-easy'
    const verdict: JobJudgeVerdict = {
      title: 'Frontend Engineer',
      company: 'Gadgets Inc',
      location: 'Remote',
      applyType: 'easy',
      externalUrl: null,
      verdict: 'relevant',
      reason: 'Good fit.',
    }

    await recordJudgeVerdict(jobId, SOURCE_URL, 'https://linkedin.com/jobs/view/3', verdict)

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('queued')

    await db.delete(jobs).where(eq(jobs.id, jobId))
  })

  test('an easy-apply verdict with a separate external link also inserts a second external_saved row', async () => {
    const db = getDb()
    const jobId = 'judge-worker-test-dual'
    const externalUrl = 'https://widgets.example.com/careers/backend-engineer'
    const verdict: JobJudgeVerdict = {
      title: 'Backend Engineer',
      company: 'Widgets Inc',
      location: 'Remote',
      applyType: 'easy',
      externalUrl,
      verdict: 'relevant',
      reason: 'Good fit.',
    }

    await recordJudgeVerdict(jobId, SOURCE_URL, 'https://linkedin.com/jobs/view/4', verdict)

    const easyRows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(easyRows).toHaveLength(1)
    expect(easyRows[0]?.status).toBe('queued')

    const externalRows = await db.select().from(jobs).where(eq(jobs.applyUrl, externalUrl))
    expect(externalRows).toHaveLength(1)
    expect(externalRows[0]?.status).toBe('external_saved')
    expect(externalRows[0]?.applyType).toBe('external')

    await db.delete(jobs).where(eq(jobs.id, jobId))
    await db.delete(jobs).where(eq(jobs.applyUrl, externalUrl))
  })

  test('never routes twice — an id already present when recordJudgeVerdict runs is left untouched', async () => {
    const db = getDb()
    const jobId = 'judge-worker-test-already-there'
    await db
      .insert(jobs)
      .values({
        id: jobId,
        title: 'Existing Title',
        company: 'Existing Co',
        applyUrl: 'https://linkedin.com/jobs/view/5',
        applyType: 'easy',
        sourceUrl: SOURCE_URL,
        status: 'applied',
      })
      .onConflictDoNothing()

    const verdict: JobJudgeVerdict = {
      title: 'Different Title',
      company: 'Different Co',
      location: null,
      applyType: 'easy',
      externalUrl: null,
      verdict: 'relevant',
      reason: 'n/a',
    }
    await recordJudgeVerdict(jobId, SOURCE_URL, 'https://linkedin.com/jobs/view/5', verdict)

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rows).toHaveLength(1)
    // Untouched by the conflicting insert — still the original row.
    expect(rows[0]?.status).toBe('applied')
    expect(rows[0]?.title).toBe('Existing Title')

    await db.delete(jobs).where(eq(jobs.id, jobId))
  })
})
