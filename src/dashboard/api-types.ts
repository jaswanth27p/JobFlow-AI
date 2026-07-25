import type { RecordedAnswer } from '../db/schema.ts'
import type { GroupedQuestion } from './review-data.ts'
import type { QuestionCluster } from './review-cluster.ts'

export type { GroupedQuestion, QuestionCluster, RecordedAnswer }

export interface SummaryDto {
  scanned: number
  found: number
  runCount: number
  applied: number
  failed: number
  queueWaiting: number
  queueActive: number
}

export interface ApplicationDto {
  applicationId: string
  jobId: string
  status: string
  result: string | null
  screenshotPath: string | null
  error: string | null
  failureReason: string | null
  missingInfoQuestion: string | null
  answers: RecordedAnswer[]
  createdAt: string | null
  jobTitle: string
  company: string
  location: string | null
  applyUrl: string
  applyType: string
  sourceUrl: string
  source: string
  jobStatus: string
  relevanceReason: string | null
  jobUpdatedAt: string | null
}

export interface ExternalJobDto {
  id: string
  title: string
  company: string
  location: string | null
  applyUrl: string
  applyType: string
  sourceUrl: string
  source: string
  status: string
  relevanceReason: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface CareerPageDto {
  id: string
  label: string
  url: string
  addedAt: string | null
  lastCheckedAt: string | null
  totalScanned: number
  relevantFound: number
  totalSkipped: number
}

export interface RetryWithAnswerBody {
  jobId: string
  question: string
  answer: string
}

export interface RetryJobBody {
  jobId: string
}

/** Bulk requeue for a batch of currently-'failed' applications selected in
 * the dashboard's Applications table — same plain retry as RetryJobBody, no
 * per-job answer collection (rows needing a missing-info answer just fail
 * again and stay selectable for the single-row retry-with-answer form). */
export interface BulkRetryJobBody {
  jobIds: string[]
}

export interface MarkAppliedBody {
  jobId: string
}

/** Bulk version of MarkAppliedBody for the External Jobs table's row-selection
 * toolbar — marks every selected job 'applied' in one request. */
export interface BulkMarkAppliedBody {
  jobIds: string[]
}

export interface ReviewFeedbackBody {
  question: string
  answer: string
  verdict: 'correct' | 'wrong'
  note?: string
}

export interface ClusterFeedbackBody {
  members: { question: string; answer: string }[]
  verdict: 'correct' | 'wrong'
  note?: string
}

export interface GenerateClustersResponse {
  clusters?: QuestionCluster[]
  error?: string
}

export interface ApiOk {
  ok: true
}

/** Returned by bulk endpoints alongside `ok` so the UI can report how many
 * rows actually matched (a stale/already-handled id in the selection is not
 * an error — it's just excluded from the count). */
export interface BulkOkResponse {
  ok: true
  count: number
}

export interface ApiError {
  error: string
}
