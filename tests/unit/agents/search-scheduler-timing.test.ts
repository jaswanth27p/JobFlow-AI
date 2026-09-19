import { describe, test, expect } from 'bun:test'

/** Mirrors the wait-math inside runAutoLoop (search-scheduler.ts) — kept as a
 * standalone pure check since runAutoLoop itself needs a real browser/queue
 * stack to exercise end to end (no live-LinkedIn e2e per project convention;
 * see docs/superpowers/specs/2026-07-14-tui-rebuild-design.md's Testing
 * section). */
function nextCycleWaitMs(elapsedMs: number, durationMs: number): number {
  return Math.max(0, durationMs - elapsedMs)
}

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
