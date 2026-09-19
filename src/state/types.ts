export type TabId = 'search' | 'easy' | 'scrape' | 'judge'
export type AgentStatus = 'idle' | 'running' | 'needs_input'

export interface TabState {
  status: AgentStatus
  step: string | null
  logs: string[]
  needsInputQuestion: string | null
}

export interface SessionStatus {
  linkedin: boolean
  gmail: boolean
  dashboard: boolean
}

export interface Settings {
  concurrency: number
  model: string
  /** Lower/upper bounds of the randomized pause after each browser navigation. */
  minNavDelayMs: number
  maxNavDelayMs: number
}

export interface AppState {
  session: SessionStatus
  activeTab: TabId
  tabs: Record<TabId, TabState>
  settings: Settings
}

export const TAB_IDS: TabId[] = ['search', 'easy', 'scrape', 'judge']

export const MAX_LOGS_PER_TAB = 500
