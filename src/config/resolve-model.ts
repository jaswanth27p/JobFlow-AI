import type { AppConfig } from './schema.ts'

export type AgentKind = 'search' | 'easyApply' | 'career' | 'judge'

/** Resolves the model id for a given agent kind: an explicit config.models
 * override if set, otherwise the passed-in fallback (appState.settings.model
 * — the /set-able live default). */
export function resolveModel(config: AppConfig, fallback: string, agent: AgentKind): string {
  return config.models[agent] ?? fallback
}
