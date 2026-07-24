import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { applications, jobs } from '../db/schema.ts'
import { saveLearnedAnswer } from '../profile/loader.ts'
import { enqueueApplyJob } from './apply-queues.ts'

export interface FailedApplication {
  jobId: string
  title: string
  company: string
  applyUrl: string
  error: string | null
  failureReason: 'missing_info' | 'blocked' | null
  missingInfoQuestion: string | null
}

/** One row per failed job — the latest application row for that job, since a
 * requeued job that fails again would otherwise produce duplicates here. */
export async function listFailedApplications(): Promise<FailedApplication[]> {
  const db = getDb()
  const rows = await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      company: jobs.company,
      applyUrl: jobs.applyUrl,
      error: applications.error,
      failureReason: applications.failureReason,
      missingInfoQuestion: applications.missingInfoQuestion,
      createdAt: applications.createdAt,
    })
    .from(jobs)
    .innerJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(eq(jobs.status, 'failed'), eq(applications.status, 'failed')))
    .orderBy(desc(applications.createdAt))

  const latestByJob = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    if (!latestByJob.has(row.jobId)) latestByJob.set(row.jobId, row)
  }

  return [...latestByJob.values()].map((r) => ({
    jobId: r.jobId,
    title: r.title,
    company: r.company,
    applyUrl: r.applyUrl,
    error: r.error,
    failureReason: r.failureReason,
    missingInfoQuestion: r.missingInfoQuestion,
  }))
}

/** Saves the human's answer for next time, resets the job to 'queued', and
 * requeues it — the next run resolves `question` via lookup-learned-answer. */
export async function retryWithAnswer(jobId: string, question: string, answer: string, profilePath: string): Promise<void> {
  await saveLearnedAnswer(profilePath, question, answer)
  const db = getDb()
  await db.update(jobs).set({ status: 'queued', updatedAt: new Date() }).where(eq(jobs.id, jobId))
  await enqueueApplyJob(jobId)
}

/** Plain requeue, no answer needed — for a 'blocked' failure (broken page,
 * navigation error, anything not a specific unanswered question), the job
 * just needs another attempt, not a saved answer. */
export async function retryJob(jobId: string): Promise<void> {
  const db = getDb()
  await db.update(jobs).set({ status: 'queued', updatedAt: new Date() }).where(eq(jobs.id, jobId))
  await enqueueApplyJob(jobId)
}

/** Requeues every currently-failed job in one go (the /retry-failed-applications
 * command). Plain requeue like retryJob — a job that specifically needs a
 * missing_info answer will just fail the same way again and show up here next
 * time; use the dashboard's per-job retry-with-answer form for those instead.
 * Returns what was requeued so the caller can report it. */
export async function retryAllFailedJobs(): Promise<FailedApplication[]> {
  const failed = await listFailedApplications()
  const db = getDb()
  for (const f of failed) {
    await db.update(jobs).set({ status: 'queued', updatedAt: new Date() }).where(eq(jobs.id, f.jobId))
    await enqueueApplyJob(f.jobId)
  }
  return failed
}

/** Manually force a job to 'applied' or 'skipped' — bypasses the queue
 * entirely. Once set, it's no longer 'failed' so /retry-failed-applications
 * (which only touches status: 'failed') will never pick it up again. Returns
 * false if the job id doesn't exist. */
export async function setJobStatus(jobId: string, status: 'applied' | 'skipped'): Promise<boolean> {
  const db = getDb()
  const result = await db
    .update(jobs)
    .set({ status, updatedAt: new Date() })
    .where(eq(jobs.id, jobId))
    .returning({ id: jobs.id })
  return result.length > 0
}
