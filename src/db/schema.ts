import { pgTable, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core'

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  company: text('company').notNull(),
  location: text('location'),
  applyUrl: text('apply_url').notNull(),
  applyType: text('apply_type', { enum: ['easy', 'external'] }).notNull(),
  sourceUrl: text('source_url').notNull(),
  /** Which agent discovered this job — drives the dashboard's Source column and
   * the /career-pages stats route. Defaults to 'linkedin' since every row before
   * this column existed came from the LinkedIn search agent. */
  source: text('source', { enum: ['linkedin', 'career_page'] }).notNull().default('linkedin'),
  status: text('status', {
    enum: ['discovered', 'queued', 'external_saved', 'needs_input', 'applied', 'failed', 'skipped'],
  }).notNull().default('discovered'),
  relevanceReason: text('relevance_reason'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

/** Raw content the scrape stage read from a job's detail page, keyed by the
 * same LinkedIn job id `jobs.id` uses. A separate table (not columns on
 * `jobs`) because `jobs.title`/`jobs.company`/`jobs.applyType` are all
 * NOT NULL and only exist once a job has been JUDGED — storing pre-judgment
 * content on `jobs` would force placeholder values and leak unjudged rows
 * into the dashboard. This table is the scrape stage's own record. */
export const jobContents = pgTable('job_contents', {
  jobId: text('job_id').primaryKey(),
  sourceUrl: text('source_url').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

/** How a submitted form answer was resolved — mirrors the resolution order both
 * apply agents' instructions spell out (structured profile field, previously-
 * learned answer, LLM inference, or a fresh human answer). */
export type AnswerSource = 'profile' | 'learned' | 'inferred' | 'human'

export interface RecordedAnswer {
  question: string
  answer: string
  source: AnswerSource
}

export const applications = pgTable('applications', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => jobs.id),
  status: text('status', { enum: ['applied', 'failed', 'needs_input'] }).notNull(),
  result: text('result'),
  screenshotPath: text('screenshot_path'),
  error: text('error'),
  /** Set only on a failed row. 'missing_info' means the agent gave up because it
   * lacked an answer for a specific on-page question (missingInfoQuestion holds
   * that exact text) — /retry-failed-applications and the dashboard retry form
   * can ask the human for it once and requeue. 'blocked'/null means a technical
   * failure (crash, broken page, unexpected state) — not safely auto-retryable,
   * surfaced as "apply manually" instead. */
  failureReason: text('failure_reason', { enum: ['missing_info', 'blocked'] }),
  missingInfoQuestion: text('missing_info_question'),
  /** Every question/answer pair the apply agent recorded while filling this
   * application, regardless of resolution path — the audit trail the daily
   * review dashboard reads. */
  answers: jsonb('answers').$type<RecordedAnswer[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow(),
})

/** Daily-review feedback log. Not the live lookup source for applying —
 * profile.json.answers stays that (read via lookup-learned-answer) — this is
 * a history of what the human marked correct/wrong and why, so a correction
 * isn't just a silent overwrite. */
export const answerReviews = pgTable('answer_reviews', {
  id: text('id').primaryKey(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  verdict: text('verdict', { enum: ['correct', 'wrong'] }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow(),
})

export const searchRuns = pgTable('search_runs', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at').defaultNow(),
  finishedAt: timestamp('finished_at'),
  urlsTried: jsonb('urls_tried').$type<string[]>().notNull().default([]),
  scannedCount: integer('scanned_count').notNull().default(0),
  relevantCount: integer('relevant_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
})

/** External (non-LinkedIn) company career/jobs pages the user tracks manually,
 * re-scanned in full on every /check-careers run — see careerPageScans below. */
export const careerPages = pgTable('career_pages', {
  id: text('id').primaryKey(),
  url: text('url').notNull().unique(),
  label: text('label').notNull(),
  addedAt: timestamp('added_at').defaultNow(),
  lastCheckedAt: timestamp('last_checked_at'),
})

/** One row per career page per /check-careers run — mirrors searchRuns, gives
 * per-page history of what a scan found. */
export const careerPageScans = pgTable('career_page_scans', {
  id: text('id').primaryKey(),
  careerPageId: text('career_page_id').notNull().references(() => careerPages.id),
  startedAt: timestamp('started_at').defaultNow(),
  finishedAt: timestamp('finished_at'),
  scannedCount: integer('scanned_count').notNull().default(0),
  relevantCount: integer('relevant_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
})
