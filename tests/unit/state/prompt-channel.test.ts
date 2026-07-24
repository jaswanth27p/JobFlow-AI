import { describe, test, expect, beforeEach } from 'bun:test'
import { waitForAnswer, answerPrompt, hasPendingPrompt } from '../../../src/state/prompt-channel.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'

beforeEach(() => {
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
})

describe('prompt-channel', () => {
  test('waitForAnswer sets the tab question and resolves once answered', async () => {
    const promise = waitForAnswer('search', 'What is your notice period?')
    expect(appState.tabs.search.needsInputQuestion).toBe('What is your notice period?')
    expect(hasPendingPrompt('search')).toBe(true)

    answerPrompt('search', '2 weeks')
    expect(await promise).toBe('2 weeks')
    expect(appState.tabs.search.needsInputQuestion).toBeNull()
    expect(hasPendingPrompt('search')).toBe(false)
  })

  test('answerPrompt returns false when there is no pending question on that tab', () => {
    expect(answerPrompt('easy', 'anything')).toBe(false)
  })

  test('prompts on different tabs do not interfere', async () => {
    const searchPromise = waitForAnswer('search', 'search question')
    const easyPromise = waitForAnswer('easy', 'easy question')

    answerPrompt('easy', 'easy answer')
    expect(await easyPromise).toBe('easy answer')
    expect(hasPendingPrompt('search')).toBe(true)

    answerPrompt('search', 'search answer')
    expect(await searchPromise).toBe('search answer')
  })
})
