import { describe, test, expect, mock } from 'bun:test'
import * as bullmq from 'bullmq'

class FakeQueue {
  static instances: FakeQueue[] = []
  added: Array<{ name: string; data: unknown; opts: unknown }> = []
  jobs = new Map<string, { id: string }>()
  closed = false
  constructor(public queueName: string) {
    FakeQueue.instances.push(this)
  }
  async add(name: string, data: unknown, opts: unknown) {
    const id = (opts as { jobId?: string })?.jobId ?? `auto-${this.added.length}`
    const job = { id }
    this.added.push({ name, data, opts })
    this.jobs.set(id, job)
    return job
  }
  async getJob(id: string) {
    return this.jobs.get(id)
  }
  async getJobCounts(..._states: string[]) {
    return { waiting: 3, active: 0 }
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

const specifier = '../../../src/queues/apply-queues.ts?__apply_queues_test'
const { enqueueApplyJob, getApplyJobByQueueId, getApplyQueueEvents, getApplyQueueCounts, closeApplyQueues } = await import(specifier)

describe('apply-queues', () => {
  test('enqueueApplyJob adds a job with NO custom jobId (so /retry-failed-applications can re-add it)', async () => {
    FakeQueue.instances.length = 0
    const job = await enqueueApplyJob('12345')
    expect(FakeQueue.instances).toHaveLength(1)
    expect(FakeQueue.instances[0]!.queueName).toBe('easy-apply')
    expect((FakeQueue.instances[0]!.added[0]!.opts as { jobId?: string }).jobId).toBeUndefined()
    expect(job.id).toBeDefined()
  })

  test('getApplyJobByQueueId looks a job up by its own BullMQ id, not the LinkedIn job id', async () => {
    const job = await enqueueApplyJob('99999')
    const found = await getApplyJobByQueueId(job.id)
    expect(found).toBe(job)
  })

  test('getApplyQueueEvents lazily creates and reuses one QueueEvents instance', () => {
    FakeQueueEvents.instances.length = 0
    const a = getApplyQueueEvents()
    const b = getApplyQueueEvents()
    expect(a).toBe(b)
  })

  test('getApplyQueueCounts reads waiting/active', async () => {
    const counts = await getApplyQueueCounts()
    expect(counts).toEqual({ waiting: 3, active: 0 })
  })

  test('closeApplyQueues closes both the queue and its QueueEvents', async () => {
    await closeApplyQueues()
    expect(FakeQueue.instances.some((q) => q.closed)).toBe(true)
    expect(FakeQueueEvents.instances.some((q) => q.closed)).toBe(true)
  })
})
