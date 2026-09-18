import { describe, test, expect } from 'bun:test'
import { loadConfig } from '../../../src/config/loader.ts'

describe('loadConfig', () => {
  test('loads and validates sample config', async () => {
    // Loads the checked-in example config, not the user's live/gitignored
    // linkedin-auto.config.ts — that file is personal, editable data (its
    // requirements text has no fixed content), so asserting against it broke
    // this test every time the user edited their own config.
    const config = await loadConfig('./linkedin-auto.config.example.ts')
    expect(config.urlGroups.length).toBeGreaterThan(0)
    expect(config.urlGroups[0]!.urls.length).toBeGreaterThan(0)
    expect(config.requirements).toContain('remote')
    expect(config.profileFiles.resume).toBe('./resume.md')
    expect(config.profileFiles.profile).toBe('./profile.json')
  })

  test('rejects config missing requirements', async () => {
    await expect(
      import('../../../src/config/schema.ts').then(({ appConfigSchema }) =>
        appConfigSchema.parse({
          urlGroups: [{ name: 'Default', urls: [{ url: 'https://example.com' }] }],
          profileFiles: { resume: './resume.md', profile: './profile.json' },
        }),
      ),
    ).rejects.toThrow()
  })

  test('defaults notifySummaryIntervalMinutes to 30 when not set', async () => {
    const { appConfigSchema } = await import('../../../src/config/schema.ts')
    const config = appConfigSchema.parse({
      urlGroups: [{ name: 'Default', urls: [{ url: 'https://example.com' }] }],
      requirements: 'remote',
      profileFiles: { resume: './resume.md', profile: './profile.json' },
    })
    expect(config.notifySummaryIntervalMinutes).toBe(30)
  })

  test('defaults scanFullList to false and models to empty object', async () => {
    const { appConfigSchema } = await import('../../../src/config/schema.ts')
    const config = appConfigSchema.parse({
      urlGroups: [{ name: 'Default', urls: [{ url: 'https://example.com' }] }],
      requirements: 'remote',
      profileFiles: { resume: './resume.md', profile: './profile.json' },
    })
    expect(config.urlGroups[0]!.urls[0]!.scanFullList).toBe(false)
    expect(config.models).toEqual({})
  })

  test('defaults judgeConcurrency to 10 and rejects out-of-range or non-integer values', async () => {
    const { appConfigSchema } = await import('../../../src/config/schema.ts')
    const base = {
      urlGroups: [{ name: 'Default', urls: [{ url: 'https://example.com' }] }],
      requirements: 'remote',
      profileFiles: { resume: './resume.md', profile: './profile.json' },
    }
    expect(appConfigSchema.parse(base).judgeConcurrency).toBe(10)
    expect(appConfigSchema.parse({ ...base, judgeConcurrency: 1 }).judgeConcurrency).toBe(1)
    expect(() => appConfigSchema.parse({ ...base, judgeConcurrency: 0 })).toThrow()
    expect(() => appConfigSchema.parse({ ...base, judgeConcurrency: 11 })).toThrow()
    expect(() => appConfigSchema.parse({ ...base, judgeConcurrency: 2.5 })).toThrow()
  })
})
