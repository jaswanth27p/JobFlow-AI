import { Worker, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { enqueueApplyJob } from './apply-queues.ts'
import { getJudgeQueueCounts } from './judge-queues.ts'
import { getRedisConnectionOptions } from './connection.ts'
import { getDb } from '../db/index.ts'
import { jobs, jobContents } from '../db/schema.ts'
import { appState, pushLog, setAgentStatus } from '../state/app-state.ts'
import { recordExternalJobFound } from '../notify/summary-aggregator.ts'
import { judgeJob } from '../agents/job-relevance-judge.ts'
import { getCurrentConfig } from '../config/current.ts'
import { resolveModel } from '../config/resolve-model.ts'
import { summarizeError } from '../utils/error-summary.ts'
import { applyUrlToJobId } from '../utils/apply-url-hash.ts'
import { logger } from '../utils/logger.ts'
import type { TabId } from '../state/types.ts'

const JUDGE_TAB: TabId = 'judge'

export async function recordJudgeVerdict(
  jobId: string,
  sourceUrl: string,
  applyUrl: string,
  verdict: Awaited<ReturnType<typeof judgeJob>>,
): Promise<{ applyJob?: Job }> {
  const db = getDb()
  const status = verdict.verdict === 'skip' ? 'skipped' : verdict.applyType === 'easy' ? 'queued' : 'external_saved'
  const inserted = await db
    .insert(jobs)
    .values({
      id: jobId,
      title: verdict.title,
      company: verdict.company,
      location: verdict.location,
      applyUrl,
      applyType: verdict.applyType,
      sourceUrl,
      status,
      relevanceReason: verdict.reason,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id })

  let applyJob: Job | undefined

  if (verdict.verdict === 'skip') {
    pushLog(JUDGE_TAB, `Reviewed "${verdict.title}" at ${verdict.company} (id ${jobId}) — not relevant, skipped. Reason: ${verdict.reason}`)
  } else if (inserted.length > 0) {
    if (verdict.applyType === 'easy') {
      applyJob = await enqueueApplyJob(jobId)
      pushLog(JUDGE_TAB, `Found "${verdict.title}" at ${verdict.company} (id ${jobId}) — added to the Easy Apply queue.`)
    } else {
      recordExternalJobFound()
      pushLog(JUDGE_TAB, `Found "${verdict.title}" at ${verdict.company} (id ${jobId}) — external apply, saved and notified.`)
    }
  } else {
    pushLog(JUDGE_TAB, `Found "${verdict.title}" at ${verdict.company} (id ${jobId}) — already recorded, not routed again.`)
  }

  if (verdict.verdict !== 'skip' && verdict.applyType === 'easy' && verdict.externalUrl) {
    const externalId = applyUrlToJobId(verdict.externalUrl)
    const externalInserted = await db
      .insert(jobs)
      .values({
        id: externalId,
        title: verdict.title,
        company: verdict.company,
        location: verdict.location,
        applyUrl: verdict.externalUrl,
        applyType: 'external',
        sourceUrl,
        status: 'external_saved',
        relevanceReason: verdict.reason,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id })

    if (externalInserted.length > 0) {
      recordExternalJobFound()
      pushLog(JUDGE_TAB, `"${verdict.title}" at ${verdict.company} also lists an external apply link — saved that too.`)
    }
  }

  return { applyJob }
}

export async function processJudgeJob(jobId: string, sourceUrl: string, signal?: AbortSignal): Promise<{ triggeredApply: boolean; applyJobId?: string }> {
  const db = getDb()
  const existing = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId))
  if (existing.length > 0) {
    pushLog(JUDGE_TAB, `Job ${jobId} already recorded — skipping (duplicate delivery).`)
    // Can't recover a prior run's apply job id here — apply-queues.ts
    // deliberately has no deterministic jobId (see its enqueueApplyJob) — so
    // this duplicate-delivery path (a resume after crash) doesn't gate the
    // scraper on whatever apply job an earlier run may have triggered.
    return { triggeredApply: false }
  }

  const contentRows = await db.select({ content: jobContents.content }).from(jobContents).where(eq(jobContents.jobId, jobId))
  const content = contentRows[0]?.content
  if (!content) {
    throw new Error(`judge: no scraped content for job ${jobId} yet`)
  }

  if (signal?.aborted) return { triggeredApply: false }

  const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`
  pushLog(JUDGE_TAB, `Judging job ${jobId}… (${content.length} chars)`)
  const counts = await getJudgeQueueCounts().catch(() => ({ waiting: 0, active: 0 }))
  setAgentStatus(JUDGE_TAB, 'running', `${counts.waiting} waiting (judging ${jobId})`)

  let verdict: Awaited<ReturnType<typeof judgeJob>>
  try {
    verdict = await judgeJob(content, resolveModel(getCurrentConfig(), appState.settings.model, 'judge'), signal)
  } catch (err) {
    if (signal?.aborted) return { triggeredApply: false }
    logger.error({ err, jobId }, 'judge: relevance judge failed')
    verdict = {
      title: 'Unknown',
      company: 'Unknown',
      location: null,
      applyType: 'external',
      externalUrl: null,
      verdict: 'skip',
      reason: `Relevance judge failed: ${summarizeError(err)}`,
    }
  }

  if (signal?.aborted) return { triggeredApply: false }
  const { applyJob } = await recordJudgeVerdict(jobId, sourceUrl, applyUrl, verdict)
  return { triggeredApply: applyJob !== undefined, applyJobId: applyJob?.id }
}

let worker: Worker | null = null
const activeAborts = new Set<AbortController>()

export function isJudgeWorkerRunning(): boolean {
  return worker !== null
}

/** One BullMQ Worker, `concurrency: 1` — hardcoded, no knob. The single-tab
 * sequential pipeline design (docs/superpowers/specs/
 * 2026-09-19-single-tab-sequential-pipeline-design.md) never has more than
 * one job in flight through the whole pipeline at a time, so parallel judge
 * calls have no work to overlap with anymore — see scrape-worker.ts's
 * await-judge-then-apply gating, which is what enforces that. */
export function startJudgeWorker(): void {
  if (worker) return

  worker = new Worker(
    'job-judge',
    async (job: Job<{ jobId: string; sourceUrl: string }>) => {
      const abort = new AbortController()
      activeAborts.add(abort)
      try {
        return await processJudgeJob(job.data.jobId, job.data.sourceUrl, abort.signal)
      } finally {
        activeAborts.delete(abort)
      }
    },
    { connection: getRedisConnectionOptions(), concurrency: 1 },
  )

  worker.on('failed', (_job, err) => {
    pushLog(JUDGE_TAB, `Judge worker error: ${err.message}`)
  })
  worker.on('error', (err) => {
    pushLog(JUDGE_TAB, `Judge worker connection error: ${err.message}`)
  })

  pushLog(JUDGE_TAB, 'Judge queue worker started.')
  setAgentStatus(JUDGE_TAB, 'running', 'starting…')
  void getJudgeQueueCounts()
    .then((c) => setAgentStatus(JUDGE_TAB, 'running', `${c.waiting} waiting in queue`))
    .catch(() => setAgentStatus(JUDGE_TAB, 'running', 'waiting for jobs'))
}

export async function stopJudgeWorker(): Promise<void> {
  if (!worker) return
  for (const abort of activeAborts) abort.abort()
  activeAborts.clear()
  await worker.close()
  worker = null
  pushLog(JUDGE_TAB, 'Judge queue worker stopped.')
  setAgentStatus(JUDGE_TAB, 'idle', null)
}
