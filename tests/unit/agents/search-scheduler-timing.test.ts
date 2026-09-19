import { describe, test, expect } from 'bun:test'
import { nextCycleWaitMs } from '../../../src/agents/search-scheduler.ts'

describe('auto mode elapsed-aware cycle timing', () => {
  test('a cycle shorter than the target duration waits out the remainder', () => {
    expect(nextCycleWaitMs(5 * 60_000, 40 * 60_000)).toBe(35 * 60_000)
  })

  test('a cycle at exactly the target duration waits zero', () => {
    expect(nextCycleWaitMs(40 * 60_000, 40 * 60_000)).toBe(0)
  })

  test('a cycle longer than the target duration starts the next one immediately', () => {
    expect(nextCycleWaitMs(130 * 60_000, 40 * 60_000)).toBe(0)
  })
})
