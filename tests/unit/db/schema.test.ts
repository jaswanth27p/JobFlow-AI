import { describe, test, expect, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { jobs, applications, answerReviews, jobContents } from '../../../src/db/schema.ts'

describe('db schema', () => {
  afterAll(async () => {
    await closeDb()
  })

  test('inserts and reads back a job row', async () => {
    const db = getDb()
    await db.insert(jobs).values({
      id: 'test-job-1',
      title: 'Senior Engineer',
      company: 'Acme',
      applyUrl: 'https://linkedin.com/jobs/view/1',
      applyType: 'easy',
      sourceUrl: 'https://linkedin.com/jobs/search/?keywords=engineer',
    }).onConflictDoNothing()

    const rows = await db.select().from(jobs).where(eq(jobs.id, 'test-job-1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('discovered')

    await db.delete(jobs).where(eq(jobs.id, 'test-job-1'))
  })

  test('accepts external_saved as a job status', async () => {
    const db = getDb()
    await db.insert(jobs).values({
      id: 'test-job-external-saved',
      title: 'Senior Engineer',
      company: 'Acme',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      applyType: 'external',
      sourceUrl: 'https://linkedin.com/jobs/search/?keywords=engineer',
      status: 'external_saved',
    }).onConflictDoNothing()

    const rows = await db.select().from(jobs).where(eq(jobs.id, 'test-job-external-saved'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('external_saved')

    await db.delete(jobs).where(eq(jobs.id, 'test-job-external-saved'))
  })

  test('applications.answers round-trips a recorded-answer array', async () => {
    const db = getDb()
    await db.insert(jobs).values({
      id: 'test-job-answers',
      title: 'Senior Engineer',
      company: 'Acme',
      applyUrl: 'https://linkedin.com/jobs/view/2',
      applyType: 'easy',
      sourceUrl: 'https://linkedin.com/jobs/search/?keywords=engineer',
    }).onConflictDoNothing()

    await db.insert(applications).values({
      id: 'test-app-answers',
      jobId: 'test-job-answers',
      status: 'applied',
      result: 'Applied successfully',
      answers: [{ question: 'Years of experience?', answer: '2', source: 'profile' }],
    })

    const rows = await db.select().from(applications).where(eq(applications.id, 'test-app-answers'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.answers).toEqual([{ question: 'Years of experience?', answer: '2', source: 'profile' }])

    await db.delete(applications).where(eq(applications.id, 'test-app-answers'))
    await db.delete(jobs).where(eq(jobs.id, 'test-job-answers'))
  })

  test('answer_reviews inserts a feedback row', async () => {
    const db = getDb()
    await db.insert(answerReviews).values({
      id: 'test-review-1',
      question: 'Are you willing to relocate?',
      answer: 'Maybe',
      verdict: 'wrong',
      note: 'No',
    })

    const rows = await db.select().from(answerReviews).where(eq(answerReviews.id, 'test-review-1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('wrong')

    await db.delete(answerReviews).where(eq(answerReviews.id, 'test-review-1'))
  })

  test('job_contents stores scraped content keyed by job id, onConflictDoNothing on a re-insert', async () => {
    const db = getDb()
    const jobId = 'test-job-contents-1'
    await db.insert(jobContents).values({
      jobId,
      sourceUrl: 'https://linkedin.com/jobs/search/?keywords=engineer',
      content: 'Senior Backend Engineer at Acme...',
    })

    const rows = await db.select().from(jobContents).where(eq(jobContents.jobId, jobId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('Senior Backend Engineer at Acme...')

    // Duplicate insert (simulating a re-delivered scrape job) must not throw
    // and must not create a second row.
    await db.insert(jobContents).values({
      jobId,
      sourceUrl: 'https://linkedin.com/jobs/search/?keywords=engineer',
      content: 'different content',
    }).onConflictDoNothing()

    const rowsAfter = await db.select().from(jobContents).where(eq(jobContents.jobId, jobId))
    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0]?.content).toBe('Senior Backend Engineer at Acme...')

    await db.delete(jobContents).where(eq(jobContents.jobId, jobId))
  })
})
