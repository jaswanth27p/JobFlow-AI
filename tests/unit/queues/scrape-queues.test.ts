import { describe, test, expect, mock } from 'bun:test'

class FakeQueue {
  static instances: FakeQueue[] = []
  added: Array<{ name: string; data: unknown; opts: unknown }> = []
  closed = false
  constructor(public queueName: string) {
    FakeQueue.instances.push(this)
  }
  async add(name: string, data: unknown, opts: unknown) {
    this.added.push({ name, data, opts })
  }
  async getJobCounts(..._states: string[]) {
    return { waiting: 2, active: 1 }
  }
  async close() {
    this.closed = true
  }
}

mock.module('bullmq', () => ({ Queue: FakeQueue }))

const specifier = '../../../src/queues/scrape-queues.ts?__scrape_queues_test'
const { enqueueScrapeJob, getScrapeQueueCounts, closeScrapeQueues } = await import(specifier)

describe('scrape-queues', () => {
  test('enqueueScrapeJob adds a job keyed by a scrape-prefixed jobId', async () => {
    FakeQueue.instances.length = 0
    await enqueueScrapeJob('12345', 'https://linkedin.com/jobs/search/?keywords=x')
    expect(FakeQueue.instances).toHaveLength(1)
    expect(FakeQueue.instances[0]!.queueName).toBe('job-scrape')
    expect(FakeQueue.instances[0]!.added[0]!.data).toEqual({ jobId: '12345', sourceUrl: 'https://linkedin.com/jobs/search/?keywords=x' })
    expect((FakeQueue.instances[0]!.added[0]!.opts as { jobId: string }).jobId).toBe('scrape-12345')
  })

  test('getScrapeQueueCounts reads waiting/active', async () => {
    const counts = await getScrapeQueueCounts()
    expect(counts).toEqual({ waiting: 2, active: 1 })
  })

  test('closeScrapeQueues closes the underlying queue', async () => {
    await closeScrapeQueues()
    expect(FakeQueue.instances.some((q) => q.closed)).toBe(true)
  })
})
