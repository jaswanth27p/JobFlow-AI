import { normalize } from '../profile/answer-matching.ts'
import type { GroupedQuestion } from './review-data.ts'
import { Agent } from '@mastra/core/agent'
import { noopLogger } from '@mastra/core/logger'

export interface ReviewedPair {
  question: string
  answer: string
}

function pairKey(question: string, answer: string): string {
  return `${normalize(question)}::${answer}`
}

/**
 * Removes any variant whose (question, answer) pair already has a human
 * verdict recorded, and drops a question entirely once none of its variants
 * remain. A pair not in `reviewed` — including a new answer to a
 * previously-reviewed question — stays visible.
 */
export function filterUnreviewed(groups: GroupedQuestion[], reviewed: ReviewedPair[]): GroupedQuestion[] {
  const reviewedKeys = new Set(reviewed.map((r) => pairKey(r.question, r.answer)))

  return groups
    .map((group) => ({
      question: group.question,
      variants: group.variants.filter((v) => !reviewedKeys.has(pairKey(group.question, v.answer))),
    }))
    .filter((group) => group.variants.length > 0)
}

export interface QuestionCluster {
  canonicalQuestion: string
  memberQuestions: string[]
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1]!.trim() : trimmed
}

/**
 * Parses the clustering model's JSON response and reconciles it against the
 * original input list: every input question ends up in exactly one cluster's
 * memberQuestions, using the ORIGINAL wording (not whatever the model echoed
 * back) so downstream answer/job lookups keyed on the original text still
 * hit. Any input question the model didn't place gets its own singleton
 * cluster — never silently dropped.
 */
export function parseClusterResponse(text: string, inputQuestions: string[]): QuestionCluster[] {
  if (inputQuestions.length === 0) return []

  const parsed: unknown = JSON.parse(stripCodeFence(text))
  if (!Array.isArray(parsed)) throw new Error('cluster response is not a JSON array')

  const byNormalized = new Map(inputQuestions.map((q) => [normalize(q), q]))
  const claimed = new Set<string>()
  const clusters: QuestionCluster[] = []

  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    const canonicalQuestion = String((raw as Record<string, unknown>).canonicalQuestion ?? '').trim()
    const memberQuestionsRaw = (raw as Record<string, unknown>).memberQuestions
    if (!canonicalQuestion || !Array.isArray(memberQuestionsRaw)) continue

    const memberQuestions: string[] = []
    for (const m of memberQuestionsRaw) {
      const original = byNormalized.get(normalize(String(m)))
      if (original && !claimed.has(original)) {
        claimed.add(original)
        memberQuestions.push(original)
      }
    }
    if (memberQuestions.length > 0) clusters.push({ canonicalQuestion, memberQuestions })
  }

  for (const q of inputQuestions) {
    if (!claimed.has(q)) clusters.push({ canonicalQuestion: q, memberQuestions: [q] })
  }

  return clusters
}

const CLUSTER_INSTRUCTIONS = `You group job-application form questions that are worded differently but ask the same underlying thing — a question belongs in the same group as another only if a form-filler would give literally the same answer to both, regardless of exact wording.

Example: "Do you require visa sponsorship?" and "Will you now or in the future require sponsorship to work in the US?" belong together. "Current salary" and "Expected salary" do NOT belong together — they are different questions.

Respond with ONLY a JSON array, no prose, no markdown fence, in this exact shape:
[{"canonicalQuestion": "<a clear phrasing of the shared question>", "memberQuestions": ["<original question text>", ...]}]

Every question in the input list must be copied verbatim into exactly one cluster's memberQuestions.`

/**
 * Sends the given question texts to a single-shot (no browser, no tools)
 * agent for semantic clustering, then parses/validates the response.
 */
export async function clusterQuestions(questions: string[], model: string): Promise<QuestionCluster[]> {
  if (questions.length === 0) return []

  const agent = new Agent({
    id: 'review-question-clusterer',
    name: 'Review Question Clusterer',
    instructions: CLUSTER_INSTRUCTIONS,
    model,
  })
  // Agent defaults to Mastra's ConsoleLogger, which writes raw (ANSI-colored)
  // errors straight to stdout — corrupts the opentui TUI frame on any error.
  agent.__setLogger(noopLogger)

  const result = await agent.generate(`Questions to group:\n${questions.map((q) => `- ${q}`).join('\n')}`)
  return parseClusterResponse(result.text, questions)
}
