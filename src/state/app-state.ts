import { createStore, produce } from 'solid-js/store'
import { TAB_IDS, MAX_LOGS_PER_TAB, type AppState, type TabId, type AgentStatus, type Settings } from './types.ts'
import { sanitizeLogLine } from '../utils/error-summary.ts'

function emptyTabState() {
  return { status: 'idle' as AgentStatus, step: null, logs: [], needsInputQuestion: null }
}

function initialState(settings: Settings): AppState {
  return {
    session: { linkedin: false, gmail: false },
    activeTab: 'search',
    tabs: {
      search: emptyTabState(),
      easy: emptyTabState(),
      external: emptyTabState(),
      careers: emptyTabState(),
    },
    settings,
  }
}

export let [appState, setAppStateInternal] = createStore<AppState>(
  initialState({ concurrency: 1, model: '', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300_000 }),
)

export function initAppState(settings: Settings): void {
  ;[appState, setAppStateInternal] = createStore<AppState>(initialState(settings))
}

export function setSessionStatus(service: 'linkedin' | 'gmail', connected: boolean): void {
  setAppStateInternal('session', service, connected)
}

export function isUnlocked(): boolean {
  return appState.session.linkedin
}

export function setActiveTab(tab: TabId): void {
  setAppStateInternal('activeTab', tab)
}

export function pushLog(tab: TabId, line: string): void {
  setAppStateInternal(
    'tabs',
    tab,
    'logs',
    produce((logs) => {
      logs.push(sanitizeLogLine(line))
      if (logs.length > MAX_LOGS_PER_TAB) logs.splice(0, logs.length - MAX_LOGS_PER_TAB)
    }),
  )
}

export function setAgentStatus(tab: TabId, status: AgentStatus, step: string | null = null): void {
  setAppStateInternal('tabs', tab, { status, step })
}

export function setNeedsInput(tab: TabId, question: string | null): void {
  setAppStateInternal('tabs', tab, 'needsInputQuestion', question)
  if (question) setAppStateInternal('tabs', tab, 'status', 'needs_input')
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  setAppStateInternal('settings', key, value)
}

export { TAB_IDS }
