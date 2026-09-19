import { describe, test, expect, mock } from 'bun:test'
import * as bullmq from 'bullmq'

class FakeQueue {
  static instances: FakeQueue[] = []
  added: Array<{ name: string; data: unknown; opts: unknown }> = []
  closed = false
  constructor(public queueName: string) {
    FakeQueue.instances.push(this)
  }
  async add(name: string, data: unknown, opts: unknown) {
    const job = { id: (opts as { jobId?: string })?.jobId ?? 'auto-id', name, data }
    this.added.push({ name, data, opts })
    return job
  }
  async getJobCounts(..._states: string[]) {
    return { waiting: 2, active: 1 }
  }
  async close() {
    this.closed = true
  }
}

class FakeQueueEvents {
  static instances: FakeQueueEvents[] = []
  closed = false
  constructor(public queueName: string) {
    FakeQueueEvents.instances.push(this)
  }
  async close() {
    this.closed = true
  }
}

mock.module('bullmq', () => ({ ...bullmq, Queue: FakeQueue, QueueEvents: FakeQueueEvents }))

const specifier = '../../../src/queues/judge-queues.ts?__judge_queues_test'
const { enqueueJudgeJob, getJudgeQueueEvents, getJudgeQueueCounts, closeJudgeQueues } = await import(specifier)

describe('judge-queues', () => {
  test('enqueueJudgeJob adds a job keyed by a judge-prefixed jobId and returns it', async () => {
    FakeQueue.instances.length = 0
    const job = await enqueueJudgeJob('12345', 'https://linkedin.com/jobs/search/?keywords=x')
    expect(FakeQueue.instances).toHaveLength(1)
    expect(FakeQueue.instances[0]!.queueName).toBe('job-judge')
    expect(job.id).toBe('judge-12345')
  })

  test('getJudgeQueueEvents lazily creates and reuses one QueueEvents instance', () => {
    FakeQueueEvents.instances.length = 0
    const a = getJudgeQueueEvents()
    const b = getJudgeQueueEvents()
    expect(a).toBe(b)
    expect(FakeQueueEvents.instances).toHaveLength(1)
    expect(FakeQueueEvents.instances[0]!.queueName).toBe('job-judge')
  })

  test('getJudgeQueueCounts reads waiting/active', async () => {
    const counts = await getJudgeQueueCounts()
    expect(counts).toEqual({ waiting: 2, active: 1 })
  })

  test('closeJudgeQueues closes both the queue and its QueueEvents', async () => {
    await closeJudgeQueues()
    expect(FakeQueue.instances.some((q) => q.closed)).toBe(true)
    expect(FakeQueueEvents.instances.some((q) => q.closed)).toBe(true)
  })
})
