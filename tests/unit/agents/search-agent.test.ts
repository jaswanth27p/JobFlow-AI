import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { writeFile, rm } from 'node:fs/promises'
import {
  computeMidPageContinueDecision,
  computeRelevanceContinueDecision,
} from '../../../src/agents/search-agent.ts'
import { buildScanInstructions } from '../../../src/prompts/search-agent.prompt.ts'
import { setCurrentConfig } from '../../../src/config/current.ts'
import { loadConfig } from '../../../src/config/loader.ts'

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
})

describe('buildScanInstructions', () => {
  const TEST_PROFILE_PATH = './data/test-profile-search-agent.json'

  beforeAll(async () => {
    await writeFile(
      TEST_PROFILE_PATH,
      JSON.stringify(
        {
          contact: { email: 'a@b.com', phone: '', location: '' },
          workAuth: { authorized: true, requiresSponsorship: false },
          experienceYears: 2,
          salaryExpectation: { min: 0, max: 0, currency: 'USD' },
          links: { linkedin: '', github: '', portfolio: '' },
          answers: {},
        },
        null,
        2,
      ),
    )
    const baseConfig = await loadConfig('./linkedin-auto.config.ts')
    setCurrentConfig({ ...baseConfig, profileFiles: { ...baseConfig.profileFiles, profile: TEST_PROFILE_PATH } })
  })

  afterAll(async () => {
    await rm(TEST_PROFILE_PATH, { force: true })
  })

  test('describes the dedupe-first, judged-relevance flow', async () => {
    const instructions = await buildScanInstructions()
    expect(instructions).toContain('check-already-seen')
    expect(instructions).toContain('report-job')
    expect(instructions).toContain('check-page-relevance-ratio')
    expect(instructions).toContain('verdict')
    expect(instructions).toContain('interactiveOnly: true')
  })
})
