import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initAppState,
  appState,
  setSessionStatus,
  isUnlocked,
  setActiveTab,
  pushLog,
  setAgentStatus,
  setNeedsInput,
} from '../../../src/state/app-state.ts'

beforeEach(() => {
  initAppState({ concurrency: 1, model: 'test-model', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
})

describe('app-state', () => {
  test('starts locked with linkedin disconnected', () => {
    expect(isUnlocked()).toBe(false)
    expect(appState.session.linkedin).toBe(false)
  })

  test('unlocks when linkedin is connected', () => {
    setSessionStatus('linkedin', true)
    expect(isUnlocked()).toBe(true)
  })

  test('setActiveTab updates activeTab', () => {
    setActiveTab('easy')
    expect(appState.activeTab).toBe('easy')
  })

  test('pushLog appends to the given tab only', () => {
    pushLog('search', 'scanning page 1')
    expect(appState.tabs.search.logs).toEqual(['scanning page 1'])
    expect(appState.tabs.easy.logs).toEqual([])
  })

  test('pushLog caps log history at MAX_LOGS_PER_TAB', () => {
    for (let i = 0; i < 510; i++) pushLog('search', `line ${i}`)
    expect(appState.tabs.search.logs.length).toBe(500)
    expect(appState.tabs.search.logs[499]).toBe('line 509')
  })

  test('setAgentStatus updates status and step', () => {
    setAgentStatus('easy', 'running', 'applying to job 3')
    expect(appState.tabs.easy.status).toBe('running')
    expect(appState.tabs.easy.step).toBe('applying to job 3')
  })

  test('setNeedsInput sets and clears the pending question', () => {
    setNeedsInput('judge', 'What is your visa status?')
    expect(appState.tabs.judge.needsInputQuestion).toBe('What is your visa status?')
    setNeedsInput('judge', null)
    expect(appState.tabs.judge.needsInputQuestion).toBeNull()
  })
})
