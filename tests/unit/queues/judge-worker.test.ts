import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { jobs, jobContents } from '../../../src/db/schema.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'
import { processJudgeJob, recordJudgeVerdict } from '../../../src/queues/judge-worker.ts'
import type { JobJudgeVerdict } from '../../../src/agents/job-relevance-judge.ts'

initAppState({ concurrency: 1, judgeConcurrency: 3, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })

// enqueueApplyJob (apply-queues.ts) opens a real ioredis connection as a side
// effect of module load / first call — mocked out so this file's DB-only
// assertions don't require Redis. recordExternalJobFound is a module-level
// counter (summary-aggregator.ts) shared process-wide across test files, same
// reasoning as easy-apply-agent.test.ts's mock of it. judgeJob is mocked so
// the "reads job_contents and judges" test doesn't make a real LLM call.
// config/current.ts is also mocked: getCurrentConfig() throws "Config not
// loaded yet" until src/index.ts's real startup path calls setCurrentConfig,
// which never happens in this unit test file (bun test gives each test file
// its own module registry, so another file's setCurrentConfig call never
// reaches this one) — processJudgeJob's resolveModel(getCurrentConfig(), ...)
// call would otherwise throw before ever reaching the mocked judgeJob above.
let judgeJobResult: JobJudgeVerdict | null = null

beforeEach(() => {
  mock.module('../../../src/queues/apply-queues.ts', () => ({ enqueueApplyJob: async () => {} }))
  mock.module('../../../src/notify/summary-aggregator.ts', () => ({ recordExternalJobFound: () => {} }))
  mock.module('../../../src/config/current.ts', () => ({
    getCurrentConfig: () => ({ models: {} }),
    setCurrentConfig: () => {},
  }))
  mock.module('../../../src/agents/job-relevance-judge.ts', () => ({
    judgeJob: async () => {
      if (!judgeJobResult) throw new Error('judgeJobResult not set for this test')
      return judgeJobResult
    },
  }))
  judgeJobResult = null
})

afterAll(async () => {
  const applyQueuesSpecifier = '../../../src/queues/apply-queues.ts?__restore_real_judge_worker_test'
  const applyQueuesReal = await import(applyQueuesSpecifier)
  mock.module('../../../src/queues/apply-queues.ts', () => ({ ...applyQueuesReal }))

  const summarySpecifier = '../../../src/notify/summary-aggregator.ts?__restore_real_judge_worker_test'
  const summaryReal = await import(summarySpecifier)
  mock.module('../../../src/notify/summary-aggregator.ts', () => ({ ...summaryReal }))

  const configCurrentSpecifier = '../../../src/config/current.ts?__restore_real_judge_worker_test'
  const configCurrentReal = await import(configCurrentSpecifier)
  mock.module('../../../src/config/current.ts', () => ({ ...configCurrentReal }))

  const judgeAgentSpecifier = '../../../src/agents/job-relevance-judge.ts?__restore_real_judge_worker_test'
  const judgeAgentReal = await import(judgeAgentSpecifier)
  mock.module('../../../src/agents/job-relevance-judge.ts', () => ({ ...judgeAgentReal }))

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

  test('throws when job_contents has no row for the id yet (scrape has not committed) — no jobs row written', async () => {
    const jobId = 'judge-worker-test-missing-content'
    await expect(processJudgeJob(jobId, SOURCE_URL)).rejects.toThrow()

    const db = getDb()
    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rows).toHaveLength(0)
  })

  test('reads job_contents.content and judges it, recording the verdict', async () => {
    const db = getDb()
    const jobId = 'judge-worker-test-reads-content'
    await db.insert(jobContents).values({ jobId, sourceUrl: SOURCE_URL, content: 'Backend Engineer role text' }).onConflictDoNothing()
    judgeJobResult = {
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      applyType: 'easy',
      externalUrl: null,
      verdict: 'relevant',
      reason: 'Good fit.',
    }

    await processJudgeJob(jobId, SOURCE_URL)

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('queued')

    await db.delete(jobs).where(eq(jobs.id, jobId))
    await db.delete(jobContents).where(eq(jobContents.jobId, jobId))
  })

  test('judgeJob throwing is recorded as a safe skip verdict, not a transient failure', async () => {
    const db = getDb()
    const jobId = 'judge-worker-test-judge-throws'
    await db.insert(jobContents).values({ jobId, sourceUrl: SOURCE_URL, content: 'Some role text' }).onConflictDoNothing()
    // judgeJobResult stays null — the mocked judgeJob (see beforeEach above)
    // throws in that case, exercising processJudgeJob's catch branch.

    await expect(processJudgeJob(jobId, SOURCE_URL)).resolves.toBeUndefined()

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('skipped')
    expect(rows[0]?.title).toBe('Unknown')
    expect(rows[0]?.company).toBe('Unknown')
    expect(rows[0]?.applyType).toBe('external')
    expect(rows[0]?.relevanceReason).toStartWith('Relevance judge failed:')

    await db.delete(jobs).where(eq(jobs.id, jobId))
    await db.delete(jobContents).where(eq(jobContents.jobId, jobId))
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
    expect(rows[0]?.status).toBe('applied')
    expect(rows[0]?.title).toBe('Existing Title')

    await db.delete(jobs).where(eq(jobs.id, jobId))
  })
})
