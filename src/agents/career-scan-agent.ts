import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'
import { createTool } from '@mastra/core/tools'
import { AgentBrowser } from '@mastra/agent-browser'
import type { ToolCallChunk, ToolResultChunk } from '@mastra/core/stream'
import { getSharedCdpUrl } from '../browser/session.ts'
import { getCurrentConfig } from '../config/current.ts'
import { resolveModel } from '../config/resolve-model.ts'
import { getDb } from '../db/index.ts'
import { jobs, careerPages, careerPageScans } from '../db/schema.ts'
import { appState, pushLog, setAgentStatus } from '../state/app-state.ts'
import { waitForAnswer } from '../state/prompt-channel.ts'
import { recordExternalJobFound } from '../notify/summary-aggregator.ts'
import { noOpBrowserContextProcessor } from './no-op-browser-context-processor.ts'
import { buildPageScanInstructions } from '../prompts/career-scan-agent.prompt.ts'
import { logger } from '../utils/logger.ts'
import { isDevLogs } from '../utils/dev-mode.ts'
import { summarizeError } from '../utils/error-summary.ts'
import { applyUrlToJobId } from '../utils/apply-url-hash.ts'
import type { TabId } from '../state/types.ts'

const CAREERS_TAB: TabId = 'careers'

const NAVIGATION_TOOLS = new Set(['browser_goto', 'browser_click', 'browser_tabs'])

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function randomNavDelayMs(): number {
  const min = Math.max(0, appState.settings.minNavDelayMs)
  const max = Math.max(min, appState.settings.maxNavDelayMs)
  return min + Math.floor(Math.random() * (max - min + 1))
}

export { applyUrlToJobId }

let sharedBrowser: AgentBrowser | null = null

function getCareerBrowser(): AgentBrowser {
  if (!sharedBrowser) {
    sharedBrowser = new AgentBrowser({
      cdpUrl: getSharedCdpUrl(),
      scope: 'shared',
      headless: false,
      excludeTools: ['browser_screenshot'],
    })
    // AgentBrowser has its own ConsoleLogger, separate from the wrapping
    // Agent's (silenced below at __setLogger(noopLogger)) — without this,
    // tool-level errors (e.g. a Playwright navigation timeout) still write
    // raw ANSI text to stdout and corrupt the opentui TUI frame.
    sharedBrowser.__setLogger(noopLogger)
  }
  return sharedBrowser
}

let activeAbort: AbortController | null = null
let activeRunPromise: Promise<void> | null = null

export function isCareerCheckRunning(): boolean {
  return activeAbort !== null
}

export function stopCareerCheck(): void {
  activeAbort?.abort()
}

export async function stopCareerCheckAndWait(): Promise<void> {
  if (!activeAbort) return
  activeAbort.abort()
  if (activeRunPromise) {
    await activeRunPromise.catch(() => {})
  }
}

interface PageScanContext {
  signal: AbortSignal
  scanned: number
  relevant: number
  skipped: number
}

function formatToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([key]) => key !== '__mastraMetadata')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

async function logCareerStep(
  event: { toolCalls: ToolCallChunk[]; toolResults: ToolResultChunk[] },
  signal: AbortSignal,
): Promise<void> {
  const devLogs = isDevLogs()
  let navigated = false
  for (const call of event.toolCalls) {
    if (devLogs) pushLog(CAREERS_TAB, `→ ${call.payload.toolName}${formatToolArgs(call.payload.args)}`)
    logger.info({ tool: call.payload.toolName, args: call.payload.args }, 'careers: tool call')
    if (NAVIGATION_TOOLS.has(call.payload.toolName)) navigated = true
  }
  for (const result of event.toolResults) {
    const status = result.payload.isError ? 'error' : 'ok'
    if (devLogs) pushLog(CAREERS_TAB, `← ${result.payload.toolName} (${status})`)
    logger.info(
      { tool: result.payload.toolName, isError: result.payload.isError, result: result.payload.result },
      'careers: tool result',
    )
  }

  if (navigated && !signal.aborted) {
    const delay = randomNavDelayMs()
    if (delay > 0) {
      await sleep(delay, signal)
    }
  }
}

function createCheckPostingSeenTool() {
  return createTool({
    id: 'check-posting-seen',
    description:
      "Check whether a posting (by its apply URL) has already been judged in a previous /check-careers run. Call this BEFORE reading/judging a posting's detail — if seen is true, skip it entirely, do not re-judge it, do not call report-posting-verdict for it.",
    inputSchema: z.object({ applyUrl: z.string() }),
    outputSchema: z.object({ seen: z.boolean() }),
    execute: async ({ applyUrl }) => {
      const id = applyUrlToJobId(applyUrl)
      const db = getDb()
      const rows = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id))
      const seen = rows.length > 0
      if (seen) {
        pushLog(CAREERS_TAB, `Skipping a posting (${applyUrl}) — already judged in an earlier check.`)
      }
      return { seen }
    },
  })
}

function createReportPostingVerdictTool(ctx: PageScanContext, sourceUrl: string) {
  return createTool({
    id: 'report-posting-verdict',
    description:
      'Report your relevance judgment for a NEW job posting you just read on this career page (one check-posting-seen did NOT flag as seen). Call this exactly once per new posting you judge.',
    inputSchema: z.object({
      title: z.string(),
      company: z.string(),
      location: z.string().optional(),
      applyUrl: z.string(),
      verdict: z.enum(['relevant', 'skip']),
      reason: z.string(),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async (input) => {
      ctx.scanned++

      if (input.verdict === 'relevant') {
        ctx.relevant++
        const id = applyUrlToJobId(input.applyUrl)
        const db = getDb()
        // check-posting-seen already gates re-judgment, but onConflictDoNothing
        // + only notifying on a real insert stays as a second safety net —
        // mirrors the pattern in search-agent.ts's judge-and-report-job.
        const inserted = await db
          .insert(jobs)
          .values({
            id,
            title: input.title,
            company: input.company,
            location: input.location ?? null,
            applyUrl: input.applyUrl,
            applyType: 'external',
            sourceUrl,
            source: 'career_page',
            status: 'external_saved',
            relevanceReason: input.reason,
          })
          .onConflictDoNothing()
          .returning({ id: jobs.id })

        if (inserted.length > 0) {
          recordExternalJobFound()
          pushLog(CAREERS_TAB, `Reviewed "${input.title}" at ${input.company} — suitable. Saved and notified.`)
        } else {
          pushLog(CAREERS_TAB, `Reviewed "${input.title}" at ${input.company} — suitable, but already recorded from an earlier check.`)
        }
      } else {
        ctx.skipped++
        pushLog(CAREERS_TAB, `Reviewed "${input.title}" at ${input.company} — not a match, skipped. Reason: ${input.reason}`)
      }

      return { ok: true }
    },
  })
}

function createRequestHumanInputTool() {
  return createTool({
    id: 'request-human-input',
    description:
      'Ask the human for help when stuck (unusual page layout, login wall, CAPTCHA, or anything else you cannot resolve yourself). Waits for their typed reply, then returns it as the answer.',
    inputSchema: z.object({ question: z.string() }),
    outputSchema: z.object({ answer: z.string() }),
    execute: async ({ question }) => {
      pushLog(CAREERS_TAB, `Needs input: ${question}`)
      const answer = await waitForAnswer(CAREERS_TAB, question)
      setAgentStatus(CAREERS_TAB, 'running')
      pushLog(CAREERS_TAB, `Got answer: ${answer}`)
      return { answer }
    },
  })
}

export async function runCareerCheck(): Promise<void> {
  if (isCareerCheckRunning()) throw new Error('A career-page check is already running')

  const db = getDb()
  const pages = await db.select().from(careerPages)
  if (pages.length === 0) {
    pushLog(CAREERS_TAB, 'No career pages tracked yet — use /add-career-url first.')
    return
  }

  const abort = new AbortController()
  activeAbort = abort

  const run = (async () => {
    try {
      const browser = getCareerBrowser()

      for (const page of pages) {
        if (abort.signal.aborted) break

        setAgentStatus(CAREERS_TAB, 'running', `scanning ${page.label}`)
        pushLog(CAREERS_TAB, `Scanning ${page.label} (${page.url})`)

        const scanId = randomUUID()
        await db.insert(careerPageScans).values({ id: scanId, careerPageId: page.id })

        const ctx: PageScanContext = { signal: abort.signal, scanned: 0, relevant: 0, skipped: 0 }

        try {
          const instructions = await buildPageScanInstructions(page.url, page.label)
          const agent = new Agent({
            id: 'career-scan-agent',
            name: 'Career Page Scan Agent',
            instructions,
            model: resolveModel(getCurrentConfig(), appState.settings.model, 'career'),
            browser,
            inputProcessors: [noOpBrowserContextProcessor],
            tools: {
              checkPostingSeen: createCheckPostingSeenTool(),
              reportPostingVerdict: createReportPostingVerdictTool(ctx, page.url),
              requestHumanInput: createRequestHumanInputTool(),
            },
          })
          // Agent defaults to Mastra's ConsoleLogger, which writes raw (ANSI-colored)
          // errors straight to stdout — corrupts the opentui TUI frame on any tool
          // error (e.g. a Playwright navigation timeout). Silence it; failures are
          // already surfaced via pushLog/logger.error at the call sites below.
          agent.__setLogger(noopLogger)

          await agent.generate(`Open ${page.url} in a new browser tab and scan it for job postings.`, {
            abortSignal: abort.signal,
            onStepFinish: (event) => logCareerStep(event, abort.signal),
            // Same maxSteps-defaults-to-5 gotcha as the other agents — fixed,
            // generous backstop against a genuinely stuck agent, not a posting
            // count budget (there's no cap on postings scanned per page).
            maxSteps: 2000,
          })
        } catch (err) {
          if (abort.signal.aborted) {
            pushLog(CAREERS_TAB, `Aborted while scanning ${page.label}.`)
          } else {
            pushLog(CAREERS_TAB, `Error scanning ${page.label}: ${summarizeError(err)}`)
            logger.error({ err, page: page.url }, 'careers: page scan failed')
          }
        }

        await db
          .update(careerPageScans)
          .set({ finishedAt: new Date(), scannedCount: ctx.scanned, relevantCount: ctx.relevant, skippedCount: ctx.skipped })
          .where(eq(careerPageScans.id, scanId))
        await db.update(careerPages).set({ lastCheckedAt: new Date() }).where(eq(careerPages.id, page.id))

        pushLog(
          CAREERS_TAB,
          `Finished ${page.label}: reviewed ${ctx.scanned} posting(s), ${ctx.relevant} saved and notified, ${ctx.skipped} skipped.`,
        )

        if (abort.signal.aborted) break
        await sleep(randomNavDelayMs(), abort.signal)
      }

      pushLog(CAREERS_TAB, abort.signal.aborted ? 'Career-page check stopped early.' : 'Career-page check finished.')
    } finally {
      activeAbort = null
      // Always drop back to idle, even when a DB write outside the per-page
      // try/catch threw — otherwise the sidebar stays stuck on "running".
      setAgentStatus(CAREERS_TAB, 'idle', null)
    }
  })()

  activeRunPromise = run.finally(() => {
    activeRunPromise = null
  })
  await run
}
