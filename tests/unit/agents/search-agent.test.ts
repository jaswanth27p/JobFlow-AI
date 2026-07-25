import { describe, test, expect } from 'bun:test'
import {
  computeMidPageContinueDecision,
  computeRelevanceContinueDecision,
} from '../../../src/agents/search-agent.ts'
import { buildScanInstructions } from '../../../src/prompts/search-agent.prompt.ts'

describe('computeMidPageContinueDecision', () => {
  test('continues when nothing has been scanned yet', () => {
    expect(computeMidPageContinueDecision({ scanned: 0, aborted: false })).toBe(true)
  })

  test('stops immediately when aborted', () => {
    expect(computeMidPageContinueDecision({ scanned: 1, aborted: true })).toBe(false)
  })

  test('stops once the per-run job cap is reached', () => {
    expect(computeMidPageContinueDecision({ scanned: 25, aborted: false, maxJobsPerRun: 25 })).toBe(false)
  })

  test('keeps going below the cap', () => {
    expect(computeMidPageContinueDecision({ scanned: 10, aborted: false, maxJobsPerRun: 25 })).toBe(true)
  })

  test('no cap applied when maxJobsPerRun is omitted', () => {
    expect(computeMidPageContinueDecision({ scanned: 1000, aborted: false })).toBe(true)
  })
})

describe('computeRelevanceContinueDecision', () => {
  test('continues when the page has not been scanned yet', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 0, pageRelevant: 0, threshold: 0.25 })).toBe(true)
  })

  test('continues when the ratio is above the threshold', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 10, pageRelevant: 5, threshold: 0.25 })).toBe(true)
  })

  test('continues when the ratio is exactly at the threshold', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 8, pageRelevant: 2, threshold: 0.25 })).toBe(true)
  })

  test('stops when the ratio is below the threshold', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 10, pageRelevant: 1, threshold: 0.25 })).toBe(false)
  })

  test('single relevant job on a single-job page continues', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 1, pageRelevant: 1, threshold: 0.25 })).toBe(true)
  })

  test('single irrelevant job on a single-job page stops', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 1, pageRelevant: 0, threshold: 0.25 })).toBe(false)
  })

  test('scanFullList bypasses the ratio check even when it would otherwise stop', () => {
    expect(
      computeRelevanceContinueDecision({ pageScanned: 10, pageRelevant: 0, threshold: 0.25, scanFullList: true }),
    ).toBe(true)
  })

  test('scanFullList defaults to off (unset behaves like false)', () => {
    expect(computeRelevanceContinueDecision({ pageScanned: 10, pageRelevant: 1, threshold: 0.25 })).toBe(false)
  })
})

describe('buildScanInstructions', () => {
  test('describes the dedupe-first, navigate-only flow (no relevance judging)', () => {
    const instructions = buildScanInstructions()
    expect(instructions).toContain('check-already-seen')
    expect(instructions).toContain('judge-and-report-job')
    expect(instructions).toContain('check-page-relevance-ratio')
    expect(instructions).toContain('interactiveOnly: true')
    // The navigator must never be told to judge relevance itself — that's the
    // isolated job-relevance-judge's job, called per job with no carryover.
    expect(instructions).not.toContain('verdict')
    expect(instructions).not.toContain('resume')
  })
})
