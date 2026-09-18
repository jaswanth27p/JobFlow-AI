import { Worker, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { enqueueApplyJob } from './apply-queues.ts'
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

/** Persists a judge verdict and routes it. Unchanged from the pre-split
 * implementation — exported (and taking a plain verdict rather than a
 * browser) so this routing logic is directly testable against a real
 * test-DB row without a live browser/CDP session. */
export async function recordJudgeVerdict(
  jobId: string,
  sourceUrl: string,
  applyUrl: string,
  verdict: Awaited<ReturnType<typeof judgeJob>>,
): Promise<void> {
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

  if (verdict.verdict === 'skip') {
    pushLog(JUDGE_TAB, `Reviewed "${verdict.title}" at ${verdict.company} (id ${jobId}) — not relevant, skipped. Reason: ${verdict.reason}`)
  } else if (inserted.length > 0) {
    if (verdict.applyType === 'easy') {
      await enqueueApplyJob(jobId)
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
}

/** Judges one queued job: re-checks for a duplicate delivery, reads the
 * content the scrape stage already persisted, judges it in isolation (no
 * browser anywhere in this function), records and routes the result.
 *
 * Missing job_contents is treated as transient (throws, so BullMQ retries
 * with backoff) rather than a judgment failure — the scrape stage may
 * simply not have committed its row yet on a fast-moving queue. A genuine
 * judge-call failure (content WAS available, judgeJob itself threw or
 * returned unparseable output) is NOT transient and resolves normally as a
 * safe 'skip' verdict — UNLESS the failure was a deliberate shutdown abort
 * (`signal.aborted`), which must not write any row at all. */
export async function processJudgeJob(jobId: string, sourceUrl: string, signal?: AbortSignal): Promise<void> {
  const db = getDb()
  const existing = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId))
  if (existing.length > 0) {
    pushLog(JUDGE_TAB, `Job ${jobId} already recorded — skipping (duplicate delivery).`)
    return
  }

  const contentRows = await db.select({ content: jobContents.content }).from(jobContents).where(eq(jobContents.jobId, jobId))
  const content = contentRows[0]?.content
  if (!content) {
    throw new Error(`judge: no scraped content for job ${jobId} yet`)
  }

  if (signal?.aborted) return

  const applyUrl = `https://www.linkedin.com/jobs/view/${jobId}/`
  pushLog(JUDGE_TAB, `Judging job ${jobId}… (${content.length} chars)`)
  setAgentStatus(JUDGE_TAB, 'running', `judging job ${jobId}`)

  let verdict: Awaited<ReturnType<typeof judgeJob>>
  try {
    verdict = await judgeJob(content, resolveModel(getCurrentConfig(), appState.settings.model, 'judge'), signal)
  } catch (err) {
    if (signal?.aborted) return
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

  if (signal?.aborted) return
  await recordJudgeVerdict(jobId, sourceUrl, applyUrl, verdict)
}

let worker: Worker | null = null
const activeAborts = new Set<AbortController>()

export function isJudgeWorkerRunning(): boolean {
  return worker !== null
}

/** One BullMQ Worker, `concurrency: judgeConcurrency` — real parallel LLM
 * calls, no browser, no per-value Chrome process. This works safely at N > 1
 * because judgeJob() builds a fresh Agent per call (job-relevance-judge.ts)
 * and processJudgeJob has no shared mutable state between concurrent
 * invocations to race on — unlike the browser stage, which is why THAT one
 * (scrape-worker.ts) is hardcoded to concurrency 1. */
export function startJudgeWorker(n: number = appState.settings.judgeConcurrency): void {
  if (worker) return

  worker = new Worker(
    'job-judge',
    async (job: Job<{ jobId: string; sourceUrl: string }>) => {
      const abort = new AbortController()
      activeAborts.add(abort)
      try {
        await processJudgeJob(job.data.jobId, job.data.sourceUrl, abort.signal)
      } finally {
        activeAborts.delete(abort)
      }
    },
    { connection: getRedisConnectionOptions(), concurrency: Math.max(1, Math.floor(n)) },
  )

  worker.on('failed', (_job, err) => {
    pushLog(JUDGE_TAB, `Judge worker error: ${err.message}`)
  })
  // Required: an EventEmitter with no 'error' listener throws on emit, which
  // would otherwise crash the process on a Redis connection hiccup.
  worker.on('error', (err) => {
    pushLog(JUDGE_TAB, `Judge worker connection error: ${err.message}`)
  })

  pushLog(JUDGE_TAB, `Judge queue worker started (concurrency ${Math.max(1, Math.floor(n))}).`)
  setAgentStatus(JUDGE_TAB, 'running', 'waiting for jobs')
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
