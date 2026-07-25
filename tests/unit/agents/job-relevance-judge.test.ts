import { describe, test, expect } from 'bun:test'
import { parseJudgeResponse } from '../../../src/agents/job-relevance-judge.ts'

describe('parseJudgeResponse', () => {
  test('parses a well-formed JSON verdict', () => {
    const text = JSON.stringify({
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      applyType: 'easy',
      externalUrl: null,
      verdict: 'relevant',
      reason: 'Stack overlaps with candidate skills.',
    })
    expect(parseJudgeResponse(text)).toEqual({
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      applyType: 'easy',
      externalUrl: null,
      verdict: 'relevant',
      reason: 'Stack overlaps with candidate skills.',
    })
  })

  test('strips a markdown code fence around the JSON', () => {
    const text = '```json\n' + JSON.stringify({
      title: 'X',
      company: 'Y',
      location: null,
      applyType: 'external',
      externalUrl: 'https://example.com/apply',
      verdict: 'skip',
      reason: 'Not a fit.',
    }) + '\n```'
    const parsed = parseJudgeResponse(text)
    expect(parsed.verdict).toBe('skip')
    expect(parsed.externalUrl).toBe('https://example.com/apply')
  })

  test('throws on malformed JSON', () => {
    expect(() => parseJudgeResponse('not json')).toThrow()
  })

  test('throws when a required field is missing', () => {
    const text = JSON.stringify({ title: 'X', company: 'Y' })
    expect(() => parseJudgeResponse(text)).toThrow()
  })
})
