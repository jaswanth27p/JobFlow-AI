import { describe, test, expect } from 'bun:test'
import {
  mergeChecklistIds,
  shouldStopScrolling,
  shouldRetryPageCollection,
  isDuplicatePage,
  isLastPage,
  detectCheckpointUrl,
  FULL_PAGE_SIZE,
} from '../../../src/agents/search-agent.ts'

describe('mergeChecklistIds', () => {
  test('appends new ids without disturbing existing order', () => {
    expect(mergeChecklistIds(['1', '2'], ['2', '3', '1', '4'])).toEqual(['1', '2', '3', '4'])
  })

  test('no-op when nothing new appears', () => {
    expect(mergeChecklistIds(['1', '2', '3'], ['2', '1'])).toEqual(['1', '2', '3'])
  })

  test('starting from empty just adopts DOM order', () => {
    expect(mergeChecklistIds([], ['5', '6', '7'])).toEqual(['5', '6', '7'])
  })

  test('empty DOM result changes nothing', () => {
    expect(mergeChecklistIds(['1', '2'], [])).toEqual(['1', '2'])
  })
})

describe('shouldStopScrolling', () => {
  test('keeps scrolling when not at the bottom yet and under a full page, regardless of new-id streak', () => {
    expect(shouldStopScrolling(false, 5, 10)).toBe(false)
  })

  test('keeps scrolling at the bottom if the no-new streak is short', () => {
    expect(shouldStopScrolling(true, 1, 25)).toBe(false)
  })

  test('stops once at the bottom AND two consecutive reads added nothing new', () => {
    expect(shouldStopScrolling(true, 2, 10)).toBe(true)
  })

  test('a longer no-new streak at the bottom still stops', () => {
    expect(shouldStopScrolling(true, 5, 10)).toBe(true)
  })

  test('stops once a full page is collected even if atBottom never reports true — the production bug this fixes', () => {
    expect(shouldStopScrolling(false, 2, FULL_PAGE_SIZE)).toBe(true)
  })

  test('a full page count alone does not stop it early — still needs the no-new streak', () => {
    expect(shouldStopScrolling(false, 0, FULL_PAGE_SIZE)).toBe(false)
  })
})

describe('shouldRetryPageCollection', () => {
  test('never retries a page that came back completely empty — that is a genuine end signal, not a skip', () => {
    expect(shouldRetryPageCollection(0, true)).toBe(false)
  })

  test('retries an undercounted page that was not flagged as genuinely empty', () => {
    expect(shouldRetryPageCollection(18, false)).toBe(true)
  })

  test('does not retry once the full page size was collected', () => {
    expect(shouldRetryPageCollection(FULL_PAGE_SIZE, false)).toBe(false)
  })

  test('does not retry when more than a full page was collected (defensive)', () => {
    expect(shouldRetryPageCollection(FULL_PAGE_SIZE + 1, false)).toBe(false)
  })
})

describe('isDuplicatePage', () => {
  test('false when there is no previous page to compare against', () => {
    expect(isDuplicatePage(['1', '2'], [])).toBe(false)
  })

  test('false when the current page came back empty', () => {
    expect(isDuplicatePage([], ['1', '2'])).toBe(false)
  })

  test('true when every current id already appeared on the previous page', () => {
    expect(isDuplicatePage(['1', '2'], ['1', '2', '3'])).toBe(true)
  })

  test('false when at least one current id is new relative to the previous page', () => {
    expect(isDuplicatePage(['1', '2', '99'], ['1', '2', '3'])).toBe(false)
  })
})

describe('isLastPage', () => {
  test('true when the page came back with zero cards', () => {
    expect(isLastPage([], ['1', '2'])).toBe(true)
  })

  test('true when the page is a clamped duplicate of the previous one', () => {
    const ids = Array.from({ length: FULL_PAGE_SIZE }, (_, i) => String(i))
    expect(isLastPage(ids, ids)).toBe(true)
  })

  test('true when the page count is under a full page and not a duplicate', () => {
    expect(isLastPage(['1', '2', '3'], ['100', '101'])).toBe(true)
  })

  test('false for a full, non-duplicate page — more pages likely follow', () => {
    const ids = Array.from({ length: FULL_PAGE_SIZE }, (_, i) => String(i))
    const previous = Array.from({ length: FULL_PAGE_SIZE }, (_, i) => String(i + 1000))
    expect(isLastPage(ids, previous)).toBe(false)
  })
})

describe('detectCheckpointUrl', () => {
  test('flags a LinkedIn checkpoint redirect', () => {
    expect(detectCheckpointUrl('https://www.linkedin.com/checkpoint/challenge/')).toContain('checkpoint')
  })

  test('flags an authwall redirect', () => {
    expect(detectCheckpointUrl('https://www.linkedin.com/authwall?trk=x')).toContain('checkpoint')
  })

  test('leaves a normal jobs search URL alone', () => {
    expect(detectCheckpointUrl('https://www.linkedin.com/jobs/search/?keywords=engineer')).toBeNull()
  })
})
