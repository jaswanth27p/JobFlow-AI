import { z } from 'zod'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'
import { buildJudgeInstructions } from '../prompts/job-relevance-judge.prompt.ts'

const judgeVerdictSchema = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  applyType: z.enum(['easy', 'external']),
  externalUrl: z.string().nullable(),
  verdict: z.enum(['relevant', 'skip']),
  reason: z.string(),
})

export type JobJudgeVerdict = z.infer<typeof judgeVerdictSchema>

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1]!.trim() : trimmed
}

/** Parses/validates the judge model's raw text response. Exported separately
 * from judgeJob so it's unit-testable without a live LLM call. */
export function parseJudgeResponse(text: string): JobJudgeVerdict {
  const parsed: unknown = JSON.parse(stripCodeFence(text))
  return judgeVerdictSchema.parse(parsed)
}

/**
 * Judges ONE job posting against the candidate's resume/profile/requirements.
 * A fresh Agent and a single-turn generate() call per invocation — no browser,
 * no tools, no shared conversation with any other posting and no shared
 * conversation with the navigating search agent that calls this. Nothing
 * about this job (or any prior one) carries forward to the next call.
 */
export async function judgeJob(jobPageText: string, model: string): Promise<JobJudgeVerdict> {
  const instructions = await buildJudgeInstructions()
  const agent = new Agent({
    id: 'job-relevance-judge',
    name: 'Job Relevance Judge',
    instructions,
    model,
  })
  agent.__setLogger(noopLogger)

  const result = await agent.generate(`Job posting page text:\n${jobPageText}`)
  return parseJudgeResponse(result.text)
}
