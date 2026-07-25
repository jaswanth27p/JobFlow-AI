import { describe, test, expect } from 'bun:test'
import { resolveModel } from '../../../src/config/resolve-model.ts'
import type { AppConfig } from '../../../src/config/schema.ts'

function makeConfig(models: AppConfig['models']): AppConfig {
  return {
    urlGroups: [],
    requirements: 'placeholder',
    concurrency: 1,
    model: 'default-model',
    models,
    notifySummaryIntervalMinutes: 30,
    profileFiles: { resume: './resume.md', profile: './profile.json' },
    extraPrompts: { search: '', easyApply: '' },
    search: { minNavDelayMs: 3000, maxNavDelayMs: 8000, loopCooldownMs: 300000 },
  }
}

describe('resolveModel', () => {
  test('falls back to the default model when no override is set', () => {
    const config = makeConfig({})
    expect(resolveModel(config, config.model, 'easyApply')).toBe('default-model')
  })

  test('uses the per-agent override when set', () => {
    const config = makeConfig({ easyApply: 'pro-model' })
    expect(resolveModel(config, config.model, 'easyApply')).toBe('pro-model')
  })

  test('an override for one agent does not affect another', () => {
    const config = makeConfig({ easyApply: 'pro-model' })
    expect(resolveModel(config, config.model, 'search')).toBe('default-model')
  })

  test('the fallback passed in wins over config.model when they differ (live /set override)', () => {
    const config = makeConfig({})
    expect(resolveModel(config, 'live-set-model', 'career')).toBe('live-set-model')
  })
})
