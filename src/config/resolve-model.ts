import { randomUUID } from 'node:crypto'
import type { MastraModelConfig } from '@mastra/core/llm'
import type { AppConfig } from './schema.ts'

export type AgentKind = 'search' | 'easyApply' | 'career' | 'judge'

// OpenCode Go rejects requests that don't identify their client: coding-agent
// CLIs send their own User-Agent plus a stable per-conversation
// `x-opencode-session`, and Go drops traffic that looks like a generic SDK or
// HTTP client (see https://opencode.ai/docs/go/#where-can-i-use-it). This app
// isn't a coding-agent CLI session, but a single process-lifetime id is a
// reasonable stand-in for "stable session": every LLM call from this running
// process shares it, satisfying the requirement without threading a per-call
// session id through every agent. Harmless to carry on any opencode.ai model.
const processSessionId = randomUUID()
const opencodeHeaders = {
  'User-Agent': 'jobflow-coding-agent/1.0',
  'x-opencode-session': processSessionId,
}

/** Turns a `provider/model` id into the model config handed to `Agent`,
 * attaching the OpenCode-required client headers when the provider is
 * opencode.ai (opencode-go / opencode). Any other provider passes through
 * unchanged so Mastra's default routing still applies. */
export function modelConfig(modelId: string): MastraModelConfig {
  return modelId.startsWith('opencode-go/') || modelId.startsWith('opencode/')
    ? { id: modelId as `${string}/${string}`, headers: opencodeHeaders }
    : modelId
}

/** Resolves the model id for a given agent kind: an explicit config.models
 * override if set, otherwise the passed-in fallback (appState.settings.model
 * — the /set-able live default). */
export function resolveModel(config: AppConfig, fallback: string, agent: AgentKind): string {
  return config.models[agent] ?? fallback
}
