import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'
import { createTool } from '@mastra/core/tools'
import type { AgentBrowser } from '@mastra/agent-browser'
import { getPipelineBrowser, ensurePipelineTab } from '../browser/pipeline-tab.ts'
import { reclaimOwnTab, type OwnedTab } from '../browser/tab-guard.ts'
import { getCurrentConfig } from '../config/current.ts'
import { modelConfig, resolveModel } from '../config/resolve-model.ts'
import { getDb } from '../db/index.ts'
import { jobs, applications, type RecordedAnswer, type AnswerSource } from '../db/schema.ts'
import { loadProfile, saveLearnedAnswer } from '../profile/loader.ts'
import { findLearnedAnswer } from '../profile/answer-matching.ts'
import { appState, pushLog, setAgentStatus } from '../state/app-state.ts'
import { waitForAnswer } from '../state/prompt-channel.ts'
import { recordEasyApplyResult } from '../notify/summary-aggregator.ts'
import { summarizeError } from '../utils/error-summary.ts'
import { logger } from '../utils/logger.ts'
import { waitForNetwork } from '../utils/network.ts'
import { noOpBrowserContextProcessor } from './no-op-browser-context-processor.ts'
import { buildApplyInstructions } from '../prompts/easy-apply-agent.prompt.ts'
import type { AppConfig } from '../config/schema.ts'
import type { TabId } from '../state/types.ts'

const EASY_TAB: TabId = 'easy'
const SCREENSHOT_DIR = './data/screenshots'

export interface JobRecord {
  id: string
  title: string
  company: string
  applyUrl: string
}

function createLookupLearnedAnswerTool(config: AppConfig) {
  return createTool({
    id: 'lookup-learned-answer',
    description:
      "Check whether this exact application question has a previously-learned answer in profile.json. Call this for any form question not directly answerable from the structured profile fields already given to you.",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ found: z.boolean(), answer: z.string().nullable() }),
    execute: async ({ question }) => {
      const profile = await loadProfile(config.profileFiles.profile)
      const answer = findLearnedAnswer(question, profile.answers)
      return { found: answer !== null, answer }
    },
  })
}

/** Phone is deliberately withheld from the agent's own instructions (see
 * buildApplyInstructions / withoutPhone in profile/loader.ts) so it never
 * enters prompt text sent to the model provider. This tool is the only way
 * the agent gets it — called on demand, right when a form field actually
 * asks for it, and returned straight from profile.json without ever being
 * embedded in the system prompt. */
function createGetPhoneNumberTool(config: AppConfig) {
  return createTool({
    id: 'get-phone-number',
    description:
      "Get the candidate's phone number. Call this only when a form field actually asks for a phone number — the number is deliberately not included in your instructions above.",
    inputSchema: z.object({}),
    outputSchema: z.object({ phone: z.string() }),
    execute: async () => {
      const profile = await loadProfile(config.profileFiles.profile)
      return { phone: profile.contact.phone }
    },
  })
}

function createAskHumanAndRememberTool(config: AppConfig) {
  return createTool({
    id: 'ask-human-and-remember',
    description:
      "Ask the human for the answer to a genuinely unknown application question (not inferable from resume/profile, and not a previously-learned answer). The answer is saved so this question is never asked again.",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
    execute: async ({ question }) => {
      pushLog(EASY_TAB, `Needs input: ${question}`)
      const answer = await waitForAnswer(EASY_TAB, question)
      setAgentStatus(EASY_TAB, 'running')
      await saveLearnedAnswer(config.profileFiles.profile, question, answer)
      pushLog(EASY_TAB, `Got answer: ${answer} (saved for next time)`)
      return { answer }
    },
  })
}

/** Set by report-submission's execute. 'written' means the applications/jobs
 * rows are already persisted (success, or a non-recoverable/'blocked' failure)
 * — processEasyApplyJob just returns. missingInfo (written: false) means the
 * failure is a specific unanswered question — processEasyApplyJob asks the
 * human right there and retries the same job before writing anything. */
export type SubmissionOutcome =
  | { success: true }
  | { success: false; written: true }
  | { success: false; written: false; missingInfo: true; question: string; error: string }

export interface SubmissionContext {
  reported: boolean
  answers: RecordedAnswer[]
  outcome?: SubmissionOutcome
}

/** Shared by report-submission's non-recoverable branch and every fallback
 * failure path in processEasyApplyJob (thrown error, agent never reported,
 * missing-info retries exhausted) — one persisted shape, one log line (with
 * the apply URL, so it's actionable without opening the DB), one recorded
 * summary-notification count, one place a human can navigate from later via
 * the dashboard. */
async function writeFailedApplication(
  job: JobRecord,
  error: string,
  failureReason: 'missing_info' | 'blocked',
  question: string | null,
  answers: RecordedAnswer[],
): Promise<void> {
  const db = getDb()
  await db.insert(applications).values({
    id: randomUUID(),
    jobId: job.id,
    status: 'failed',
    error,
    failureReason,
    missingInfoQuestion: question,
    answers,
  })
  await db.update(jobs).set({ status: 'failed', updatedAt: new Date() }).where(eq(jobs.id, job.id))
  // Full error (may be a multi-line Playwright message) is kept in the DB
  // above; the TUI log line gets the one-line summary so it doesn't break the
  // LogPanel's layout — see error-summary.ts.
  pushLog(EASY_TAB, `Failed: ${job.title} @ ${job.company} (id ${job.id}) — ${summarizeError(error)}`)
  recordEasyApplyResult(false)
}

/** Exported so the answer-tracking flow can be tested directly against a fake
 * ctx/browser without a live LLM or browser session. */
export function createRecordAnswerTool(ctx: SubmissionContext) {
  return createTool({
    id: 'record-answer',
    description:
      "Record the question and answer you just used for a form field, and how you resolved it. Call this for EVERY field you fill, regardless of which resolution path you used (structured profile field, lookup-learned-answer, your own inference, or ask-human-and-remember) — this is the only record of what was actually submitted, for later human review.",
    inputSchema: z.object({
      question: z.string(),
      answer: z.string(),
      source: z.enum(['profile', 'learned', 'inferred', 'human']),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async ({ question, answer, source }) => {
      ctx.answers.push({ question, answer, source: source as AnswerSource })
      return { ok: true }
    },
  })
}

/** Exported so the answer-tracking flow can be tested directly against a fake
 * ctx/browser without a live LLM or browser session. */
export function createReportSubmissionTool(job: JobRecord, browser: AgentBrowser, ctx: SubmissionContext) {
  return createTool({
    id: 'report-submission',
    description:
      'Report the final result of this application. Call this exactly once, after you submit the application (success) or after you determine you cannot complete it (failure).',
    inputSchema: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      reason: z.enum(['missing_info', 'blocked']).optional(),
      question: z.string().optional(),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async (input) => {
      ctx.reported = true

      if (input.success) {
        const db = getDb()
        let screenshotPath: string | null = null
        try {
          const shot = await browser.screenshot({ fullPage: false })
          if ('base64' in shot) {
            await mkdir(SCREENSHOT_DIR, { recursive: true })
            screenshotPath = join(SCREENSHOT_DIR, `${job.id}-${Date.now()}.png`)
            await writeFile(screenshotPath, Buffer.from(shot.base64, 'base64'))
          }
        } catch {
          // Screenshot is best-effort proof, not required for a successful application.
        }

        await db.insert(applications).values({
          id: randomUUID(),
          jobId: job.id,
          status: 'applied',
          result: 'Applied successfully',
          screenshotPath,
          answers: ctx.answers,
        })
        await db.update(jobs).set({ status: 'applied', updatedAt: new Date() }).where(eq(jobs.id, job.id))
        pushLog(EASY_TAB, `Applied: ${job.title} @ ${job.company}`)
        recordEasyApplyResult(true)
        ctx.outcome = { success: true }
      } else if (input.reason === 'missing_info' && input.question) {
        // Don't persist yet — processEasyApplyJob asks the human for this exact
        // question right now and retries the same job before anything is written.
        ctx.outcome = { success: false, written: false, missingInfo: true, question: input.question, error: input.error ?? 'Missing information' }
      } else {
        const error = input.error ?? 'Unknown failure'
        await writeFailedApplication(job, error, 'blocked', null, ctx.answers)
        ctx.outcome = { success: false, written: true }
      }

      return { ok: true }
    },
  })
}

export async function processEasyApplyJob(jobId: string, signal?: AbortSignal): Promise<void> {
  const db = getDb()
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobId))
  const job = rows[0]

  if (!job) {
    pushLog(EASY_TAB, `Job ${jobId} not found in database — skipping.`)
    return
  }

  if (job.status === 'applied' || job.status === 'failed' || job.status === 'skipped') {
    pushLog(EASY_TAB, `Job ${jobId} already ${job.status} — skipping.`)
    return
  }

  // Blocks here (checking every minute) instead of racing into a doomed tab
  // open — stops a connectivity drop from burning through every queued
  // application one after another, each written off as 'failed'.
  if ((await waitForNetwork(EASY_TAB, signal)) === 'aborted') return

  const config = getCurrentConfig()

  const jobRecord: JobRecord = { id: job.id, title: job.title, company: job.company, applyUrl: job.applyUrl }

  // Opened/reused by code, not the LLM (see tab-guard.ts) — this is the one
  // shared pipeline tab (see pipeline-tab.ts), reused across every retry
  // attempt below AND across every job this worker ever processes (navigated
  // in place, never closed between jobs), and shared with search/scrape too.
  const { browser, cdpUrl } = getPipelineBrowser()
  let ownTab: OwnedTab
  try {
    ownTab = await ensurePipelineTab(jobRecord.applyUrl, `/jobs/view/${jobRecord.id}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeFailedApplication(jobRecord, `Failed to open apply tab: ${message}`, 'blocked', null, [])
    return
  }

  await processEasyApplyJobInTab(job, jobRecord, config, browser, cdpUrl, ownTab, signal)
}

async function processEasyApplyJobInTab(
  job: typeof jobs.$inferSelect,
  jobRecord: JobRecord,
  config: AppConfig,
  browser: AgentBrowser,
  cdpUrl: string,
  ownTab: OwnedTab,
  signal?: AbortSignal,
): Promise<void> {
  // Bounded so a job that keeps needing new info can't loop forever — after
  // this many "ask human, retry" rounds it's written as failed instead of
  // retried again. A genuinely blocked/technical failure never loops at all,
  // it's written on the first pass (see the 'blocked' branch below).
  const MAX_ATTEMPTS = 3
  let carriedAnswers: RecordedAnswer[] = []

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctx: SubmissionContext = { reported: false, answers: [...carriedAnswers] }

    try {
      const instructions = await buildApplyInstructions(config, jobRecord)
      const agent = new Agent({
        id: 'easy-apply-agent',
        name: 'Easy Apply Agent',
        instructions,
        model: modelConfig(resolveModel(config, appState.settings.model, 'easyApply')),
        browser,
        inputProcessors: [noOpBrowserContextProcessor],
        tools: {
          lookupLearnedAnswer: createLookupLearnedAnswerTool(config),
          getPhoneNumber: createGetPhoneNumberTool(config),
          askHumanAndRemember: createAskHumanAndRememberTool(config),
          recordAnswer: createRecordAnswerTool(ctx),
          reportSubmission: createReportSubmissionTool(jobRecord, browser, ctx),
        },
      })
      // Agent defaults to Mastra's ConsoleLogger, which writes raw (ANSI-colored)
      // errors straight to stdout — corrupts the opentui TUI frame on any tool
      // error (e.g. a Playwright navigation timeout). Silence it; failures are
      // already surfaced via pushLog/logger.error at the call sites below.
      agent.__setLogger(noopLogger)

      pushLog(
        EASY_TAB,
        attempt === 1
          ? `Opening application: ${job.title} @ ${job.company}`
          : `Retrying application (attempt ${attempt}/${MAX_ATTEMPTS}): ${job.title} @ ${job.company}`,
      )
      // Close the gap between opening/reopening this tab and the agent's first
      // action — onStepFinish below only guards between steps, not before the
      // very first one.
      await reclaimOwnTab(browser, cdpUrl, ownTab)

      // Mastra's Agent.generate defaults maxSteps to 5 tool-call steps total — a
      // real multi-field application (open, fill several fields, maybe multiple
      // Easy Apply pages, report-submission) blows past that easily, so without
      // this the agent silently stops mid-form and the job gets written as
      // failed even though nothing actually went wrong. Not set to something huge/
      // unbounded, though: this is the ONLY circuit breaker against a genuinely
      // stuck agent (e.g. repeatedly retrying the same failed click) — the BullMQ
      // worker (concurrency: 1) has no job timeout, so a runaway loop would burn
      // tokens and block every other queued application indefinitely otherwise.
      await agent.generate(`Apply to this job now. Job detail/apply URL: ${jobRecord.applyUrl}`, {
        maxSteps: 150,
        // The search agent (or a future job's own tab-open) can silently steal
        // this agent's "active tab" pointer the instant it opens a tab anywhere
        // in the shared browser — see tab-guard.ts. Reclaim before every step.
        onStepFinish: () => reclaimOwnTab(browser, cdpUrl, ownTab),
        // Without this, nothing could actually interrupt a running
        // agent.generate() call — stopEasyApplyWorker()/the shutdown path
        // could only abort the AbortController and then wait, unbounded, for
        // this to finish naturally (up to maxSteps:150 worth of tool calls),
        // which on /exit either hung the whole app or forced a user to kill
        // the process outright, tearing down the browser out from under a
        // still-running generate() call (surfaced as raw "Browser was closed
        // externally"/CDP-connect errors dumped to the terminal after exit).
        // Passing the signal lets Mastra stop the loop promptly instead.
        abortSignal: signal,
      })
    } catch (err) {
      // A deliberate stop (queue stop / app shutdown), not a real failure —
      // don't write a 'failed' row for it. The job stays whatever status it
      // already had (still 'queued'), so it's simply picked up again next
      // time the easy-apply queue runs.
      if (signal?.aborted) return
      // A connection error here means the bootstrap browser died mid-job —
      // there is no separate dedicated browser to relaunch anymore (see
      // pipeline-tab.ts); a dead bootstrap browser has no relaunch path in
      // this session (session.ts's getSharedCdpUrl throws until the app is
      // restarted), so this is just recorded as a failure like any other.
      if (!ctx.reported) {
        const message = err instanceof Error ? err.message : String(err)
        await writeFailedApplication(jobRecord, message, 'blocked', null, ctx.answers)
      }
      return
    }

    if (signal?.aborted) return

    if (!ctx.reported) {
      await writeFailedApplication(jobRecord, 'Agent finished without reporting a result', 'blocked', null, ctx.answers)
      return
    }

    const outcome = ctx.outcome
    if (!outcome || outcome.success || outcome.written) return

    // missing_info, not yet persisted — ask the human right now, no command needed.
    if (attempt < MAX_ATTEMPTS) {
      pushLog(EASY_TAB, `${job.title} @ ${job.company} needs: ${outcome.question}`)
      const answer = await waitForAnswer(EASY_TAB, outcome.question)
      setAgentStatus(EASY_TAB, 'running')
      await saveLearnedAnswer(config.profileFiles.profile, outcome.question, answer)
      pushLog(EASY_TAB, `Got answer — retrying: ${job.title} @ ${job.company}`)
      carriedAnswers = ctx.answers
      continue
    }

    await writeFailedApplication(jobRecord, outcome.error, 'missing_info', outcome.question, ctx.answers)
    return
  }
}
