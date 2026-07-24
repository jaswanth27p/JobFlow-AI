import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { clearRegistryForTest, getCommand } from '../../../src/commands/registry.ts'
import { registerCareerCommands, parseCareerUrl, deriveLabelFromUrl } from '../../../src/commands/career-commands.ts'
import { initAppState, appState } from '../../../src/state/app-state.ts'
import { getDb, closeDb } from '../../../src/db/index.ts'
import { careerPages } from '../../../src/db/schema.ts'

beforeEach(() => {
  clearRegistryForTest()
  initAppState({ concurrency: 1, model: 'test', minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 })
  registerCareerCommands()
})

afterAll(async () => {
  const db = getDb()
  await db.delete(careerPages).where(eq(careerPages.url, 'https://example.com/careers'))
  await closeDb()
})

describe('parseCareerUrl', () => {
  test('accepts http(s) URLs', () => {
    expect(parseCareerUrl('https://stripe.com/jobs')).not.toBeNull()
    expect(parseCareerUrl('http://example.com')).not.toBeNull()
  })

  test('rejects non-http(s) and malformed input', () => {
    expect(parseCareerUrl('not a url')).toBeNull()
    expect(parseCareerUrl('ftp://example.com')).toBeNull()
    expect(parseCareerUrl('')).toBeNull()
  })
})

describe('deriveLabelFromUrl', () => {
  test('strips protocol, path, and leading www', () => {
    expect(deriveLabelFromUrl('https://www.stripe.com/jobs/search')).toBe('stripe.com')
    expect(deriveLabelFromUrl('https://boards.greenhouse.io/acme')).toBe('boards.greenhouse.io')
  })
})

describe('career commands', () => {
  test('registers all three careers-tab commands', () => {
    expect(getCommand('add-career-url')?.scope).toBe('careers')
    expect(getCommand('check-careers')?.scope).toBe('careers')
    expect(getCommand('stop-careers')?.scope).toBe('careers')
  })

  test('/stop-careers is a no-op with a message when nothing is running', async () => {
    await getCommand('stop-careers')!.run({ args: [], rawArgs: '' })
    expect(appState.tabs.careers.logs).toContain('No career-page check is running.')
  })

  test('/add-career-url with no args logs usage', async () => {
    await getCommand('add-career-url')!.run({ args: [], rawArgs: '' })
    expect(appState.tabs.careers.logs).toContain('Usage: /add-career-url <url> [label]')
  })

  test('/add-career-url with an invalid URL logs a rejection, does not insert', async () => {
    await getCommand('add-career-url')!.run({ args: ['not-a-url'], rawArgs: 'not-a-url' })
    expect(appState.tabs.careers.logs).toContain('Not a valid http(s) URL: not-a-url')
  })

  test('/add-career-url stores a new URL, then rejects re-adding the same one', async () => {
    await getCommand('add-career-url')!.run({
      args: ['https://example.com/careers', 'Example', 'Co'],
      rawArgs: 'https://example.com/careers Example Co',
    })
    expect(appState.tabs.careers.logs.some((l) => l.includes('Tracking career page: Example Co'))).toBe(true)

    const db = getDb()
    const rows = await db.select().from(careerPages).where(eq(careerPages.url, 'https://example.com/careers'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.label).toBe('Example Co')

    await getCommand('add-career-url')!.run({ args: ['https://example.com/careers'], rawArgs: 'https://example.com/careers' })
    expect(appState.tabs.careers.logs).toContain('Already tracking https://example.com/careers')

    const rowsAfter = await db.select().from(careerPages).where(eq(careerPages.url, 'https://example.com/careers'))
    expect(rowsAfter).toHaveLength(1)
  })
})
