import type {
  SummaryDto,
  ApplicationDto,
  ExternalJobDto,
  CareerPageDto,
  GroupedQuestion,
  RetryWithAnswerBody,
  RetryJobBody,
  BulkRetryJobBody,
  MarkAppliedBody,
  BulkMarkAppliedBody,
  ReviewFeedbackBody,
  ClusterFeedbackBody,
  GenerateClustersResponse,
  ApiOk,
  BulkOkResponse,
} from '../../dashboard/api-types.ts'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function postJson<TBody, TResp>(path: string, body: TBody): Promise<TResp> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as TResp & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `${path} failed: ${res.status}`)
  return data
}

export const api = {
  getSummary: () => getJson<SummaryDto>('/api/summary'),
  getApplications: () => getJson<ApplicationDto[]>('/api/applications'),
  retryApplication: (body: RetryWithAnswerBody) => postJson<RetryWithAnswerBody, ApiOk>('/api/applications/retry', body),
  retryApplicationJob: (body: RetryJobBody) => postJson<RetryJobBody, ApiOk>('/api/applications/retry-job', body),
  retryApplicationJobsBulk: (body: BulkRetryJobBody) =>
    postJson<BulkRetryJobBody, BulkOkResponse>('/api/applications/retry-job-bulk', body),
  getExternalJobs: () => getJson<ExternalJobDto[]>('/api/external-jobs'),
  markExternalJobApplied: (body: MarkAppliedBody) => postJson<MarkAppliedBody, ApiOk>('/api/external-jobs/mark-applied', body),
  markExternalJobsAppliedBulk: (body: BulkMarkAppliedBody) =>
    postJson<BulkMarkAppliedBody, BulkOkResponse>('/api/external-jobs/mark-applied-bulk', body),
  getCareerPages: () => getJson<CareerPageDto[]>('/api/career-pages'),
  getUnreviewed: () => getJson<GroupedQuestion[]>('/api/review/unreviewed'),
  generateClusters: () => postJson<Record<string, never>, GenerateClustersResponse>('/api/review/generate', {}),
  submitFeedback: (body: ReviewFeedbackBody) => postJson<ReviewFeedbackBody, ApiOk>('/api/review/feedback', body),
  submitClusterFeedback: (body: ClusterFeedbackBody) => postJson<ClusterFeedbackBody, ApiOk>('/api/review/cluster-feedback', body),
}
