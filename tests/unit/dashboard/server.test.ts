import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { eq, inArray } from 'drizzle-orm'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { answerReviews, jobs } from '../../../src/db/schema.ts'
import { setCurrentConfig } from '../../../src/config/current.ts'
import { loadConfig } from '../../../src/config/loader.ts'
import { handleRequest } from '../../../src/dashboard/server.ts'

const TEST_PROFILE_PATH = './data/test-profile-dashboard.json'

beforeAll(async () => {
  await writeFile(
    TEST_PROFILE_PATH,
    JSON.stringify(
      {
        contact: { email: 'a@b.com', phone: '', location: '' },
        workAuth: { authorized: true, requiresSponsorship: false },
        experienceYears: 2,
        salaryExpectation: { min: 0, max: 0, currency: 'USD' },
        links: { linkedin: '', github: '', portfolio: '' },
        answers: {},
      },
      null,
      2,
    ),
  )
  const baseConfig = await loadConfig('./linkedin-auto.config.ts')
  setCurrentConfig({ ...baseConfig, profileFiles: { ...baseConfig.profileFiles, profile: TEST_PROFILE_PATH } })
})

afterAll(async () => {
  await rm(TEST_PROFILE_PATH, { force: true })
  await closeDb()
})

function postJson(path: string, body: unknown): Promise<Response> {
  return handleRequest(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('dashboard handleRequest /api/*', () => {
  test('GET /api/summary returns summary JSON', async () => {
    const res = await handleRequest(new Request('http://localhost/api/summary'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.applied).toBe('number')
    expect(typeof body.externalSaved).toBe('number')
  })

  test('GET /api/applications returns an array', async () => {
    const res = await handleRequest(new Request('http://localhost/api/applications'))
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('GET /api/external-jobs returns an array', async () => {
    const res = await handleRequest(new Request('http://localhost/api/external-jobs'))
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('GET /api/review/unreviewed returns an array', async () => {
    const res = await handleRequest(new Request('http://localhost/api/review/unreviewed'))
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('GET /api/career-pages returns an array', async () => {
    const res = await handleRequest(new Request('http://localhost/api/career-pages'))
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('unknown /api route returns 404 JSON', async () => {
    const res = await handleRequest(new Request('http://localhost/api/nope'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not found')
  })

  test('POST /api/external-jobs/mark-applied with missing jobId returns 400', async () => {
    const res = await postJson('/api/external-jobs/mark-applied', {})
    expect(res.status).toBe(400)
  })

  test('POST /api/external-jobs/mark-applied-bulk with missing jobIds returns 400', async () => {
    const res = await postJson('/api/external-jobs/mark-applied-bulk', {})
    expect(res.status).toBe(400)
  })

  test('POST /api/external-jobs/mark-applied-bulk with empty jobIds array returns 400', async () => {
    const res = await postJson('/api/external-jobs/mark-applied-bulk', { jobIds: [] })
    expect(res.status).toBe(400)
  })

  test('POST /api/external-jobs/mark-applied-bulk marks every selected job applied in one request', async () => {
    const db = getDb()
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    await db.insert(jobs).values(
      ids.map((id, i) => ({
        id,
        title: `Bulk Test Job ${i}`,
        company: 'Acme',
        applyUrl: 'https://example.com/apply',
        applyType: 'external' as const,
        sourceUrl: 'https://example.com/job',
        source: 'linkedin' as const,
        status: 'external_saved' as const,
      })),
    )

    const res = await postJson('/api/external-jobs/mark-applied-bulk', { jobIds: ids })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; count: number }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(3)

    const rows = await db.select({ status: jobs.status }).from(jobs).where(inArray(jobs.id, ids))
    expect(rows.every((r) => r.status === 'applied')).toBe(true)

    await db.delete(jobs).where(inArray(jobs.id, ids))
  })

  test('POST /api/applications/retry-job-bulk with missing jobIds returns 400', async () => {
    const res = await postJson('/api/applications/retry-job-bulk', {})
    expect(res.status).toBe(400)
  })

  test('POST /api/review/feedback with a wrong verdict writes back to profile.json.answers and logs a review', async () => {
    const res = await postJson('/api/review/feedback', {
      question: 'Are you willing to relocate?',
      answer: 'Maybe',
      verdict: 'wrong',
      note: 'No',
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)

    const db = getDb()
    const rows = await db.select().from(answerReviews).where(eq(answerReviews.question, 'Are you willing to relocate?'))
    expect(rows.length).toBeGreaterThan(0)

    const saved = JSON.parse(await Bun.file(TEST_PROFILE_PATH).text())
    expect(saved.answers['Are you willing to relocate?']).toBe('No')

    await db.delete(answerReviews).where(eq(answerReviews.question, 'Are you willing to relocate?'))
  })

  test('POST /api/review/generate returns clusters or an error field, never throws', async () => {
    const res = await postJson('/api/review/generate', {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { clusters?: unknown[]; error?: string }
    expect(body.clusters !== undefined || body.error !== undefined).toBe(true)
  })
})
