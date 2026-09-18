import { describe, test, expect } from 'bun:test'
import { applyUrlToJobId } from '../../../src/utils/apply-url-hash.ts'

describe('applyUrlToJobId', () => {
  test('is stable across calls for the same URL', () => {
    const url = 'https://acme.com/jobs/1'
    expect(applyUrlToJobId(url)).toBe(applyUrlToJobId(url))
  })

  test('differs for different URLs', () => {
    expect(applyUrlToJobId('https://acme.com/jobs/1')).not.toBe(applyUrlToJobId('https://acme.com/jobs/2'))
  })

  test('trims whitespace before hashing, so a re-judged posting still dedups', () => {
    expect(applyUrlToJobId('https://acme.com/jobs/1 ')).toBe(applyUrlToJobId('https://acme.com/jobs/1'))
  })
})
