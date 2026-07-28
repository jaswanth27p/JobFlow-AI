import { randomUUID } from 'node:crypto'
import { eq, desc, gte, sql, inArray, and } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { jobs, applications, answerReviews, careerPages, careerPageScans } from '../db/schema.ts'
import { getApplyQueueCounts } from '../queues/apply-queues.ts'
import { getCurrentConfig } from '../config/current.ts'
import { saveLearnedAnswer } from '../profile/loader.ts'
import { retryWithAnswer, retryJob } from '../queues/retry.ts'
import { groupAnswersByQuestion, type ApplicationAnswers } from './review-data.ts'
import { logger } from '../utils/logger.ts'
import { filterUnreviewed, clusterQuestions } from './review-cluster.ts'
import { appState, setSessionStatus } from '../state/app-state.ts'
import type {
  SummaryDto,
  ApplicationDto,
  ExternalJobDto,
  CareerPageDto,
  GroupedQuestion,
  RetryWithAnswerBody,
  RetryJobBody,
  MarkAppliedBody,
  GenerateClustersResponse,
  ApiOk,
  BulkOkResponse,
} from './api-types.ts'

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

/** Shared shape check for every bulk endpoint's body: a non-empty array of
 * non-empty strings under `jobIds`. Returns null (valid) or an error Response. */
function parseJobIdsBody(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const jobIds = (body as { jobIds?: unknown }).jobIds
  if (!Array.isArray(jobIds) || jobIds.length === 0) return null
  if (!jobIds.every((id) => typeof id === 'string' && id.length > 0)) return null
  return jobIds
}

async function getSummary(): Promise<SummaryDto> {
  const db = getDb()
  const since = startOfToday()

  const todayApps = await db.select().from(applications).where(gte(applications.createdAt, since))
  const applied = todayApps.filter((a) => a.status === 'applied').length
  const failed = todayApps.filter((a) => a.status === 'failed').length

  const todayExternal = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'external_saved'), gte(jobs.createdAt, since)))
  const externalSaved = todayExternal.length

  const easyCounts = await getApplyQueueCounts()

  return {
    applied,
    externalSaved,
    failed,
    queueWaiting: easyCounts.waiting,
    queueActive: easyCounts.active,
  }
}

async function getApplications(): Promise<ApplicationDto[]> {
  const db = getDb()
  const rows = await db
    .select({
      applicationId: applications.id,
      jobId: applications.jobId,
      status: applications.status,
      result: applications.result,
      screenshotPath: applications.screenshotPath,
      error: applications.error,
      failureReason: applications.failureReason,
      missingInfoQuestion: applications.missingInfoQuestion,
      answers: applications.answers,
      createdAt: applications.createdAt,
      jobTitle: jobs.title,
      company: jobs.company,
      location: jobs.location,
      applyUrl: jobs.applyUrl,
      applyType: jobs.applyType,
      sourceUrl: jobs.sourceUrl,
      source: jobs.source,
      jobStatus: jobs.status,
      relevanceReason: jobs.relevanceReason,
      jobUpdatedAt: jobs.updatedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .orderBy(desc(applications.createdAt))
    .limit(200)

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
    jobUpdatedAt: r.jobUpdatedAt?.toISOString() ?? null,
  }))
}

async function handleRetry(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Partial<RetryWithAnswerBody> | null
  if (!body?.jobId || !body.question || !body.answer) return json({ error: 'bad request' }, 400)

  const config = getCurrentConfig()
  await retryWithAnswer(body.jobId, body.question, body.answer, config.profileFiles.profile)

  return json({ ok: true } satisfies ApiOk)
}

/** Plain requeue for a 'blocked' failure (broken page, navigation error,
 * anything that isn't a specific unanswered question) — no answer to collect. */
async function handleRetryJob(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Partial<RetryJobBody> | null
  if (!body?.jobId) return json({ error: 'bad request' }, 400)

  await retryJob(body.jobId)

  return json({ ok: true } satisfies ApiOk)
}

/** Bulk version of handleRetryJob for the Applications table's row-selection
 * toolbar — same plain requeue as a single retry, applied to every selected id. */
async function handleBulkRetryJob(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as unknown
  const jobIds = parseJobIdsBody(body)
  if (!jobIds) return json({ error: 'bad request' }, 400)

  for (const jobId of jobIds) await retryJob(jobId)

  return json({ ok: true, count: jobIds.length } satisfies BulkOkResponse)
}

async function getExternalJobs(): Promise<ExternalJobDto[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      applyUrl: jobs.applyUrl,
      applyType: jobs.applyType,
      sourceUrl: jobs.sourceUrl,
      source: jobs.source,
      status: jobs.status,
      relevanceReason: jobs.relevanceReason,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(inArray(jobs.status, ['external_saved', 'applied']))
    .orderBy(desc(jobs.createdAt))
    .limit(200)

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  }))
}

/** External jobs have no apply automation — the human applies manually on the
 * source site and comes back here to record it, so the list can be filtered
 * down to what's still outstanding. */
async function handleMarkExternalApplied(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Partial<MarkAppliedBody> | null
  if (!body?.jobId) return json({ error: 'bad request' }, 400)

  const db = getDb()
  await db.update(jobs).set({ status: 'applied', updatedAt: new Date() }).where(eq(jobs.id, body.jobId))

  return json({ ok: true } satisfies ApiOk)
}

/** Bulk version of handleMarkExternalApplied for the External Jobs table's
 * row-selection toolbar — one query for the whole selection instead of one
 * round trip per row. Returns the count actually matched (a row already
 * marked applied, or removed, by the time the request lands is silently
 * excluded rather than erroring the whole batch). */
async function handleBulkMarkExternalApplied(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as unknown
  const jobIds = parseJobIdsBody(body)
  if (!jobIds) return json({ error: 'bad request' }, 400)

  const db = getDb()
  const updated = await db
    .update(jobs)
    .set({ status: 'applied', updatedAt: new Date() })
    .where(inArray(jobs.id, jobIds))
    .returning({ id: jobs.id })

  return json({ ok: true, count: updated.length } satisfies BulkOkResponse)
}

async function getCareerPages(): Promise<CareerPageDto[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: careerPages.id,
      url: careerPages.url,
      label: careerPages.label,
      addedAt: careerPages.addedAt,
      lastCheckedAt: careerPages.lastCheckedAt,
      totalScanned: sql<number>`coalesce(sum(${careerPageScans.scannedCount}), 0)`,
      relevantFound: sql<number>`coalesce(sum(${careerPageScans.relevantCount}), 0)`,
      totalSkipped: sql<number>`coalesce(sum(${careerPageScans.skippedCount}), 0)`,
    })
    .from(careerPages)
    .leftJoin(careerPageScans, eq(careerPageScans.careerPageId, careerPages.id))
    .groupBy(careerPages.id)
    .orderBy(careerPages.addedAt)

  return rows.map((r) => ({
    ...r,
    addedAt: r.addedAt?.toISOString() ?? null,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
  }))
}

async function loadReviewedPairs() {
  const db = getDb()
  return db.select({ question: answerReviews.question, answer: answerReviews.answer }).from(answerReviews)
}

async function loadUnreviewedGroups(): Promise<GroupedQuestion[]> {
  const db = getDb()
  const rows = await db
    .select({ jobId: applications.jobId, answers: applications.answers, jobTitle: jobs.title, company: jobs.company })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))

  const grouped = groupAnswersByQuestion(rows as ApplicationAnswers[])
  const reviewed = await loadReviewedPairs()
  return filterUnreviewed(grouped, reviewed)
}

async function handleGenerateClusters(): Promise<Response> {
  const groups = await loadUnreviewedGroups()
  const questions = groups.map((g) => g.question)

  try {
    const clusters = await clusterQuestions(questions, appState.settings.model)
    return json({ clusters } satisfies GenerateClustersResponse)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'dashboard: question clustering failed')
    return json({ error: message } satisfies GenerateClustersResponse)
  }
}

interface ClusterFeedbackPair {
  question: string
  answer: string
}

function isClusterFeedbackPair(v: unknown): v is ClusterFeedbackPair {
  return typeof v === 'object' && v !== null && typeof (v as any).question === 'string' && typeof (v as any).answer === 'string'
}

async function handleClusterFeedback(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { members?: unknown; verdict?: unknown; note?: unknown }
    | null

  if (!body) return json({ error: 'bad request' }, 400)

  const membersRaw = body.members
  const verdictRaw = body.verdict
  const note = typeof body.note === 'string' ? body.note : undefined

  if (verdictRaw !== 'correct' && verdictRaw !== 'wrong') return json({ error: 'bad request' }, 400)
  // Explicit annotation on a fresh binding, not just relying on narrowing —
  // same pattern the pre-rewrite handler used for this exact verdict field
  // (see the removed `handleClusterFeedback`'s comment about drizzle's
  // `.values()` overload widening a CFA-narrowed union back to `string`).
  const verdict: 'correct' | 'wrong' = verdictRaw

  if (!Array.isArray(membersRaw) || membersRaw.length === 0 || !membersRaw.every(isClusterFeedbackPair)) {
    return json({ error: 'bad request' }, 400)
  }
  const members: ClusterFeedbackPair[] = membersRaw

  const db = getDb()
  await db
    .insert(answerReviews)
    .values(members.map((m) => ({ id: randomUUID(), question: m.question, answer: m.answer, verdict, note: note ?? null })))

  if (verdict === 'wrong' && note) {
    const config = getCurrentConfig()
    const distinctQuestions = [...new Set(members.map((m) => m.question))]
    for (const question of distinctQuestions) {
      await saveLearnedAnswer(config.profileFiles.profile, question, note)
    }
    logger.info({ questions: distinctQuestions, note }, 'dashboard: corrected learned answer (cluster)')
  }

  return json({ ok: true } satisfies ApiOk)
}

async function handleFeedback(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { question?: unknown; answer?: unknown; verdict?: unknown; note?: unknown }
    | null

  if (!body) return json({ error: 'bad request' }, 400)

  const question = typeof body.question === 'string' ? body.question : ''
  const answer = typeof body.answer === 'string' ? body.answer : ''
  const verdictRaw = body.verdict
  const note = typeof body.note === 'string' ? body.note : undefined

  if (!question || !answer || (verdictRaw !== 'correct' && verdictRaw !== 'wrong')) {
    return json({ error: 'bad request' }, 400)
  }
  const verdict: 'correct' | 'wrong' = verdictRaw

  const db = getDb()
  await db.insert(answerReviews).values({ id: randomUUID(), question, answer, verdict, note: note ?? null })

  if (verdict === 'wrong' && note) {
    const config = getCurrentConfig()
    await saveLearnedAnswer(config.profileFiles.profile, question, note)
    logger.info({ question, note }, 'dashboard: corrected learned answer')
  }

  return json({ ok: true } satisfies ApiOk)
}

const distDir = new URL('../dashboard-ui/dist/', import.meta.url)

/** Serves the built SPA. Any path that isn't an existing built asset falls
 * back to index.html so react-router owns client-side routes like
 * /applications — there is no server-side route for those paths. */
async function serveStatic(pathname: string): Promise<Response> {
  const relPath = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = Bun.file(new URL(relPath, distDir))
  if (await file.exists()) return new Response(file)

  const indexFile = Bun.file(new URL('index.html', distDir))
  if (await indexFile.exists()) return new Response(indexFile)

  return new Response('dashboard UI not built — run `bun run dashboard:build`', { status: 500 })
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/summary') return json(await getSummary())
    if (req.method === 'GET' && pathname === '/api/applications') return json(await getApplications())
    if (req.method === 'POST' && pathname === '/api/applications/retry') return handleRetry(req)
    if (req.method === 'POST' && pathname === '/api/applications/retry-job') return handleRetryJob(req)
    if (req.method === 'POST' && pathname === '/api/applications/retry-job-bulk') return handleBulkRetryJob(req)
    if (req.method === 'GET' && pathname === '/api/external-jobs') return json(await getExternalJobs())
    if (req.method === 'POST' && pathname === '/api/external-jobs/mark-applied') return handleMarkExternalApplied(req)
    if (req.method === 'POST' && pathname === '/api/external-jobs/mark-applied-bulk') return handleBulkMarkExternalApplied(req)
    if (req.method === 'GET' && pathname === '/api/review/unreviewed') return json(await loadUnreviewedGroups())
    if (req.method === 'POST' && pathname === '/api/review/generate') return handleGenerateClusters()
    if (req.method === 'POST' && pathname === '/api/review/cluster-feedback') return handleClusterFeedback(req)
    if (req.method === 'POST' && pathname === '/api/review/feedback') return handleFeedback(req)
    if (req.method === 'GET' && pathname === '/api/career-pages') return json(await getCareerPages())
    return json({ error: 'not found' }, 404)
  }

  if (req.method === 'GET') return serveStatic(pathname)
  return new Response('not found', { status: 404 })
}

let server: ReturnType<typeof Bun.serve> | null = null
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 4870

export function isDashboardRunning(): boolean {
  return server !== null
}

export function getDashboardUrl(): string | null {
  return server ? `http://127.0.0.1:${DASHBOARD_PORT}` : null
}

export function startDashboard(): void {
  if (server) return
  try {
    // Bind loopback only — this serves the user's application history and
    // personal answers; it must never be reachable from the LAN.
    server = Bun.serve({ port: DASHBOARD_PORT, hostname: '127.0.0.1', fetch: handleRequest })
    setSessionStatus('dashboard', true)
    logger.info({ port: DASHBOARD_PORT }, 'dashboard: listening')
  } catch (err) {
    // A busy port must not take the whole app down — the dashboard is optional.
    logger.error({ err, port: DASHBOARD_PORT }, 'dashboard: failed to start (port in use?) — continuing without it')
  }
}

export function stopDashboard(): void {
  server?.stop(true)
  server = null
  setSessionStatus('dashboard', false)
}
