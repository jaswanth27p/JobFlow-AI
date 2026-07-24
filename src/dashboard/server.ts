import { randomUUID } from 'node:crypto'
import { eq, desc, gte, sql, inArray } from 'drizzle-orm'
import { getDb } from '../db/index.ts'
import { jobs, applications, searchRuns, answerReviews, careerPages, careerPageScans } from '../db/schema.ts'
import { getApplyQueueCounts } from '../queues/apply-queues.ts'
import { getCurrentConfig } from '../config/current.ts'
import { saveLearnedAnswer } from '../profile/loader.ts'
import { retryWithAnswer, retryJob } from '../queues/retry.ts'
import { groupAnswersByQuestion, type ApplicationAnswers } from './review-data.ts'
import { logger } from '../utils/logger.ts'
import { filterUnreviewed, clusterQuestions, type ReviewedPair, type QuestionCluster } from './review-cluster.ts'
import { appState } from '../state/app-state.ts'

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Search box + optional status dropdown, and the click-to-sort/filter script
 * that goes with them — same behavior /applications already had, factored out
 * so /external-jobs and /career-pages get it too instead of being static
 * tables. `th` elements that should sort need `data-sort` set in the caller's
 * markup; columns holding only a link (Apply URL, Source URL, ...) are
 * conventionally left out since sorting by link text isn't useful.
 */
function sortableFilterableTable(opts: {
  tableId: string
  statusColIndex?: number
  statusOptions?: string[]
  /** Pre-selects this status in the dropdown on page load (still overridable
   * by the user via "All statuses") — e.g. external jobs default to hiding
   * ones already marked applied. */
  defaultStatusValue?: string
}): { toolbarHtml: string; scriptHtml: string } {
  const hasStatusFilter = opts.statusColIndex !== undefined && opts.statusOptions !== undefined

  const toolbarHtml = `
    <div class="table-toolbar">
      ${
        hasStatusFilter
          ? `<select id="${opts.tableId}StatusFilter">
               <option value="">All statuses</option>
               ${opts.statusOptions!
                 .map(
                   (s) =>
                     `<option value="${escapeHtml(s)}"${s === opts.defaultStatusValue ? ' selected' : ''}>${escapeHtml(s)}</option>`,
                 )
                 .join('')}
             </select>`
          : ''
      }
      <input type="text" id="${opts.tableId}Search" placeholder="Search..." />
    </div>`

  const scriptHtml = `
    <script>
      (function () {
        var table = document.getElementById('${opts.tableId}');
        var tbody = table.tBodies[0];
        var search = document.getElementById('${opts.tableId}Search');
        ${hasStatusFilter ? `var statusFilter = document.getElementById('${opts.tableId}StatusFilter');` : ''}
        var statusCol = ${opts.statusColIndex ?? -1};

        Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, idx) {
          if (!th.hasAttribute('data-sort')) return;
          th.style.cursor = 'pointer';
          var dir = 1;
          th.addEventListener('click', function () {
            var rows = Array.prototype.slice.call(tbody.rows);
            rows.sort(function (a, b) {
              var av = a.cells[idx].innerText.trim();
              var bv = b.cells[idx].innerText.trim();
              return av.localeCompare(bv, undefined, { numeric: true }) * dir;
            });
            dir *= -1;
            rows.forEach(function (row) { tbody.appendChild(row); });
          });
        });

        function applyFilters() {
          var searchVal = search.value.toLowerCase();
          Array.prototype.forEach.call(tbody.rows, function (row) {
            var matchesStatus = statusCol < 0 || ${hasStatusFilter ? '!statusFilter.value || row.cells[statusCol].innerText.trim() === statusFilter.value' : 'true'};
            var matchesSearch = !searchVal || row.innerText.toLowerCase().indexOf(searchVal) !== -1;
            row.style.display = matchesStatus && matchesSearch ? '' : 'none';
          });
        }

        search.addEventListener('input', applyFilters);
        ${hasStatusFilter ? `statusFilter.addEventListener('change', applyFilters);` : ''}
        applyFilters();
      })();
    </script>`

  return { toolbarHtml, scriptHtml }
}

function page(body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Application Review</title>
<style>
  :root {
    --bg: #f5f6f8;
    --surface: #ffffff;
    --border: #e1e4e8;
    --text: #1f2328;
    --text-muted: #57606a;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --danger: #b42318;
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0;
    background: var(--bg);
    color: var(--text);
  }
  .page-container { max-width: 960px; margin: 0 auto; padding: 1.5rem 2rem 3rem; }
  nav {
    display: flex;
    gap: 0.25rem;
    padding: 0.75rem 2rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  nav a {
    padding: 0.4rem 0.9rem;
    border-radius: var(--radius);
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
  }
  nav a:hover { background: var(--bg); color: var(--text); }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  section, fieldset {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  fieldset { border: 1px solid var(--border); }
  legend { font-weight: 600; padding: 0 0.4rem; }
  table {
    border-collapse: collapse;
    width: 100%;
    background: var(--surface);
    border-radius: var(--radius);
    overflow: hidden;
  }
  th, td { padding: 0.55rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); }
  th {
    background: var(--bg);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-muted);
    position: sticky;
    top: 0;
  }
  tbody tr:nth-child(even) { background: #fafbfc; }
  tbody tr:hover { background: #f0f4ff; }
  a { color: var(--accent); }
  button, input[type="submit"] {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    padding: 0.45rem 0.9rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  input[type="text"] {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
  }
  .error-banner {
    background: #fdecea;
    border: 1px solid #f5b5ac;
    color: var(--danger);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  .reference-block { color: var(--text-muted); font-size: 0.9rem; margin: 0.5rem 0; }
  .table-toolbar { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .table-scroll { overflow-x: auto; }
  .table-scroll table { min-width: max-content; }
  .id-cell { font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--text-muted); }
</style>
</head><body>
<nav><a href="/">Summary</a><a href="/applications">Applications</a><a href="/external-jobs">External Jobs</a><a href="/review">Review</a><a href="/career-pages">Career Pages</a></nav>
<div class="page-container">${body}</div>
</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

async function renderSummary(): Promise<Response> {
  const db = getDb()
  const since = startOfToday()

  const todayRuns = await db.select().from(searchRuns).where(gte(searchRuns.startedAt, since))
  const scanned = todayRuns.reduce((sum, r) => sum + r.scannedCount, 0)
  const found = todayRuns.reduce((sum, r) => sum + r.relevantCount, 0)

  const todayApps = await db.select().from(applications).where(gte(applications.createdAt, since))
  const applied = todayApps.filter((a) => a.status === 'applied').length
  const failed = todayApps.filter((a) => a.status === 'failed').length

  const easyCounts = await getApplyQueueCounts()

  return page(`
    <h1>Today</h1>
    <p>Search: ${scanned} scanned, ${found} found (${todayRuns.length} run(s))</p>
    <p>Applications: ${applied} applied, ${failed} failed</p>
    <p>Easy Apply queue: ${easyCounts.waiting} waiting / ${easyCounts.active} active</p>
  `)
}

const SOURCE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  career_page: 'Career Page',
}

async function renderApplications(): Promise<Response> {
  const db = getDb()
  const rows = await db
    .select({
      applicationId: applications.id,
      jobId: applications.jobId,
      status: applications.status,
      result: applications.result,
      screenshotPath: applications.screenshotPath,
      error: applications.error,
      failureReason: applications.failureReason,
      missingInfoQuestion: applications.missingInfoQuestion,
      answers: applications.answers,
      createdAt: applications.createdAt,
      jobTitle: jobs.title,
      company: jobs.company,
      location: jobs.location,
      applyUrl: jobs.applyUrl,
      applyType: jobs.applyType,
      sourceUrl: jobs.sourceUrl,
      source: jobs.source,
      jobStatus: jobs.status,
      relevanceReason: jobs.relevanceReason,
      jobUpdatedAt: jobs.updatedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .orderBy(desc(applications.createdAt))
    .limit(200)

  const items = rows
    .map((r) => {
      const canRetryWithAnswer = r.status === 'failed' && r.failureReason === 'missing_info' && r.missingInfoQuestion
      const action =
        r.status !== 'failed'
          ? ''
          : canRetryWithAnswer
            ? `<form method="post" action="/applications/retry">
                 <input type="hidden" name="jobId" value="${escapeHtml(r.jobId)}" />
                 <input type="hidden" name="question" value="${escapeHtml(r.missingInfoQuestion!)}" />
                 <p class="reference-block">${escapeHtml(r.missingInfoQuestion!)}</p>
                 <input type="text" name="answer" placeholder="answer" required />
                 <button type="submit">Retry</button>
               </form>`
            : `<form method="post" action="/applications/retry-job" style="display:inline">
                 <input type="hidden" name="jobId" value="${escapeHtml(r.jobId)}" />
                 <button type="submit">Retry</button>
               </form>
               <a href="${escapeHtml(r.applyUrl)}">Apply manually</a>`

      return `
    <tr>
      <td class="id-cell">${escapeHtml(r.applicationId)}</td>
      <td class="id-cell">${escapeHtml(r.jobId)}</td>
      <td>${escapeHtml(r.jobTitle)}</td>
      <td>${escapeHtml(r.company)}</td>
      <td>${escapeHtml(r.location ?? '')}</td>
      <td>${SOURCE_LABELS[r.source] ?? r.source}</td>
      <td>${escapeHtml(r.applyType)}</td>
      <td><a href="${escapeHtml(r.applyUrl)}">${escapeHtml(r.applyUrl)}</a></td>
      <td><a href="${escapeHtml(r.sourceUrl)}">${escapeHtml(r.sourceUrl)}</a></td>
      <td>${escapeHtml(r.jobStatus)}</td>
      <td>${escapeHtml(r.relevanceReason ?? '')}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.result ?? '')}</td>
      <td>${escapeHtml(r.error ?? '')}</td>
      <td>${escapeHtml(r.screenshotPath ?? '')}</td>
      <td>${r.answers.length} answer(s)</td>
      <td>${r.createdAt?.toISOString() ?? ''}</td>
      <td>${r.jobUpdatedAt?.toISOString() ?? ''}</td>
      <td>${action}</td>
    </tr>`
    })
    .join('')

  const { toolbarHtml, scriptHtml } = sortableFilterableTable({
    tableId: 'appsTable',
    statusColIndex: 11,
    statusOptions: ['applied', 'failed', 'needs_input'],
  })

  return page(`
    <h1>Applications</h1>
    ${toolbarHtml}
    <div class="table-scroll"><table id="appsTable"><thead><tr>
      <th data-sort>App ID</th><th data-sort>Job ID</th><th data-sort>Job</th><th data-sort>Company</th><th data-sort>Location</th><th data-sort>Source</th><th data-sort>Apply Type</th><th>Apply URL</th><th>Source URL</th><th data-sort>Job Status</th><th data-sort>Relevance Reason</th><th data-sort>App Status</th><th data-sort>Result</th><th data-sort>Error</th><th data-sort>Screenshot Path</th><th data-sort>Answers</th><th data-sort>Applied At</th><th data-sort>Job Updated</th><th>Action</th>
    </tr></thead><tbody>${items}</tbody></table></div>
    ${scriptHtml}
  `)
}

async function renderExternalJobs(): Promise<Response> {
  const db = getDb()
  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      applyUrl: jobs.applyUrl,
      applyType: jobs.applyType,
      sourceUrl: jobs.sourceUrl,
      source: jobs.source,
      status: jobs.status,
      relevanceReason: jobs.relevanceReason,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(inArray(jobs.status, ['external_saved', 'applied']))
    .orderBy(desc(jobs.createdAt))
    .limit(200)

  const items = rows
    .map((r) => {
      const action =
        r.status === 'applied'
          ? ''
          : `<form method="post" action="/external-jobs/mark-applied" style="display:inline">
               <input type="hidden" name="jobId" value="${escapeHtml(r.id)}" />
               <button type="submit">Mark Applied</button>
             </form>`

      return `
    <tr>
      <td class="id-cell">${escapeHtml(r.id)}</td>
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.company)}</td>
      <td>${escapeHtml(r.location ?? '')}</td>
      <td>${SOURCE_LABELS[r.source] ?? r.source}</td>
      <td>${escapeHtml(r.applyType)}</td>
      <td><a href="${escapeHtml(r.applyUrl)}">${escapeHtml(r.applyUrl)}</a></td>
      <td><a href="${escapeHtml(r.sourceUrl)}">${escapeHtml(r.sourceUrl)}</a></td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.relevanceReason ?? '')}</td>
      <td>${r.createdAt?.toISOString() ?? ''}</td>
      <td>${r.updatedAt?.toISOString() ?? ''}</td>
      <td>${action}</td>
    </tr>`
    })
    .join('')

  const { toolbarHtml, scriptHtml } = sortableFilterableTable({
    tableId: 'extJobsTable',
    statusColIndex: 8,
    statusOptions: ['external_saved', 'applied'],
    defaultStatusValue: 'external_saved',
  })

  return page(
    `<h1>External Jobs</h1>
    ${toolbarHtml}
    <div class="table-scroll"><table id="extJobsTable"><thead><tr><th data-sort>Job ID</th><th data-sort>Job</th><th data-sort>Company</th><th data-sort>Location</th><th data-sort>Source</th><th data-sort>Apply Type</th><th>Apply URL</th><th>Source URL</th><th data-sort>Status</th><th data-sort>Relevance Reason</th><th data-sort>Found</th><th data-sort>Updated</th><th>Action</th></tr></thead><tbody>${items}</tbody></table></div>
    ${scriptHtml}
    ${rows.length === 0 ? '<p>No external jobs saved yet.</p>' : ''}`,
  )
}

async function renderCareerPages(): Promise<Response> {
  const db = getDb()
  const rows = await db
    .select({
      id: careerPages.id,
      url: careerPages.url,
      label: careerPages.label,
      addedAt: careerPages.addedAt,
      lastCheckedAt: careerPages.lastCheckedAt,
      totalScanned: sql<number>`coalesce(sum(${careerPageScans.scannedCount}), 0)`,
      relevantFound: sql<number>`coalesce(sum(${careerPageScans.relevantCount}), 0)`,
      totalSkipped: sql<number>`coalesce(sum(${careerPageScans.skippedCount}), 0)`,
    })
    .from(careerPages)
    .leftJoin(careerPageScans, eq(careerPageScans.careerPageId, careerPages.id))
    .groupBy(careerPages.id)
    .orderBy(careerPages.addedAt)

  const items = rows
    .map(
      (r) => `
    <tr>
      <td class="id-cell">${escapeHtml(r.id)}</td>
      <td>${escapeHtml(r.label)}</td>
      <td><a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a></td>
      <td>${r.addedAt?.toISOString() ?? ''}</td>
      <td>${r.lastCheckedAt?.toISOString() ?? 'never'}</td>
      <td>${r.totalScanned}</td>
      <td>${r.relevantFound}</td>
      <td>${r.totalSkipped}</td>
    </tr>`,
    )
    .join('')

  const { toolbarHtml, scriptHtml } = sortableFilterableTable({ tableId: 'careerPagesTable' })

  return page(
    `<h1>Career Pages</h1>
    ${toolbarHtml}
    <div class="table-scroll"><table id="careerPagesTable"><thead><tr><th data-sort>ID</th><th data-sort>Label</th><th>URL</th><th data-sort>Added</th><th data-sort>Last checked</th><th data-sort>Scanned (all time)</th><th data-sort>Relevant found (all time)</th><th data-sort>Skipped (all time)</th></tr></thead><tbody>${items}</tbody></table></div>
    ${scriptHtml}
    ${rows.length === 0 ? '<p>No career pages tracked yet — use /add-career-url.</p>' : ''}`,
  )
}

async function loadReviewedPairs(): Promise<ReviewedPair[]> {
  const db = getDb()
  return db.select({ question: answerReviews.question, answer: answerReviews.answer }).from(answerReviews)
}

async function loadUnreviewedGroups() {
  const db = getDb()
  const rows = await db
    .select({ jobId: applications.jobId, answers: applications.answers, jobTitle: jobs.title, company: jobs.company })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))

  const grouped = groupAnswersByQuestion(rows as ApplicationAnswers[])
  const reviewed = await loadReviewedPairs()
  return filterUnreviewed(grouped, reviewed)
}

function renderUnreviewedList(groups: Awaited<ReturnType<typeof loadUnreviewedGroups>>): string {
  return groups
    .map(
      (g) => `
    <fieldset>
      <legend>${escapeHtml(g.question)}</legend>
      ${g.variants
        .map(
          (v) => `
        <div>
          <p>${escapeHtml(v.answer)} <small>(${v.jobs.length} application(s))</small></p>
          <form method="post" action="/review/feedback">
            <input type="hidden" name="question" value="${escapeHtml(g.question)}" />
            <input type="hidden" name="answer" value="${escapeHtml(v.answer)}" />
            <button name="verdict" value="correct">Correct</button>
            <input type="text" name="note" placeholder="corrected answer (if wrong)" />
            <button name="verdict" value="wrong">Wrong</button>
          </form>
        </div>`,
        )
        .join('')}
    </fieldset>`,
    )
    .join('')
}

function renderClusters(clusters: QuestionCluster[], groups: Awaited<ReturnType<typeof loadUnreviewedGroups>>): string {
  const groupByQuestion = new Map(groups.map((g) => [g.question, g]))

  return clusters
    .map((cluster, i) => {
      const members = cluster.memberQuestions
        .map((q) => groupByQuestion.get(q))
        .filter((g): g is NonNullable<typeof g> => g !== undefined)

      const pairsJson = escapeHtml(
        JSON.stringify(members.flatMap((g) => g.variants.map((v) => ({ question: g.question, answer: v.answer })))),
      )

      const referenceHtml = members
        .map(
          (g) => `
        <div class="reference-block">
          <strong>${escapeHtml(g.question)}</strong>
          ${g.variants.map((v) => `<div>&rarr; ${escapeHtml(v.answer)} <small>(${v.jobs.length} application(s))</small></div>`).join('')}
        </div>`,
        )
        .join('')

      return `
    <section>
      <h2>${escapeHtml(cluster.canonicalQuestion)}</h2>
      ${referenceHtml}
      <form method="post" action="/review/cluster-feedback">
        <input type="hidden" name="members" value="${pairsJson}" />
        <button name="verdict" value="correct">All correct</button>
        <input type="text" name="note" placeholder="corrected answer to use for all of these (if wrong)" />
        <button name="verdict" value="wrong">Wrong</button>
      </form>
    </section>`
    })
    .join('')
}

async function renderReview(errorMessage?: string, clusters?: QuestionCluster[]): Promise<Response> {
  const groups = await loadUnreviewedGroups()

  const errorHtml = errorMessage ? `<div class="error-banner">${escapeHtml(errorMessage)}</div>` : ''
  const generateForm = `<form method="post" action="/review/generate"><button type="submit">Generate unique questions</button></form>`
  const clustersHtml = clusters ? `<h1>Clustered questions</h1>${renderClusters(clusters, groups)}` : ''
  const listHtml = `<h1>Unreviewed</h1>${generateForm}${renderUnreviewedList(groups) || '<p>No unreviewed answers.</p>'}`

  return page(`${errorHtml}${clustersHtml}${clustersHtml ? '<hr />' : ''}${listHtml}`)
}

async function handleGenerate(): Promise<Response> {
  const groups = await loadUnreviewedGroups()
  const questions = groups.map((g) => g.question)

  try {
    const clusters = await clusterQuestions(questions, appState.settings.model)
    return renderReview(undefined, clusters)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'dashboard: question clustering failed')
    return renderReview(`Failed to generate unique questions: ${message}`)
  }
}

interface ClusterFeedbackPair {
  question: string
  answer: string
}

function isClusterFeedbackPair(v: unknown): v is ClusterFeedbackPair {
  return typeof v === 'object' && v !== null && typeof (v as any).question === 'string' && typeof (v as any).answer === 'string'
}

async function handleClusterFeedback(req: Request): Promise<Response> {
  const form = await req.formData()
  const membersRaw = String(form.get('members') ?? '')
  const verdictRaw = String(form.get('verdict') ?? '')
  const note = form.get('note') ? String(form.get('note')) : undefined

  if (verdictRaw !== 'correct' && verdictRaw !== 'wrong') {
    return new Response('bad request', { status: 400 })
  }
  // Re-bind to an explicitly-typed literal union: TS's overload resolution for
  // drizzle's `.values()` widens a CFA-narrowed `string` back to `string` when
  // it's read inside a fresh object literal built by `.map()` below (no
  // contextual type flows into the callback for an overloaded generic call).
  // An explicit type annotation on a fresh binding sidesteps that widening.
  const verdict: 'correct' | 'wrong' = verdictRaw

  let members: ClusterFeedbackPair[]
  try {
    const parsed: unknown = JSON.parse(membersRaw)
    if (!Array.isArray(parsed) || !parsed.every(isClusterFeedbackPair) || parsed.length === 0) {
      throw new Error('empty or malformed members list')
    }
    members = parsed
  } catch {
    return new Response('bad request', { status: 400 })
  }

  const db = getDb()
  await db
    .insert(answerReviews)
    .values(members.map((m) => ({ id: randomUUID(), question: m.question, answer: m.answer, verdict, note: note ?? null })))

  if (verdict === 'wrong' && note) {
    const config = getCurrentConfig()
    const distinctQuestions = [...new Set(members.map((m) => m.question))]
    for (const question of distinctQuestions) {
      await saveLearnedAnswer(config.profileFiles.profile, question, note)
    }
    logger.info({ questions: distinctQuestions, note }, 'dashboard: corrected learned answer (cluster)')
  }

  return new Response(null, { status: 303, headers: { Location: '/review' } })
}

async function handleFeedback(req: Request): Promise<Response> {
  const form = await req.formData()
  const question = String(form.get('question') ?? '')
  const answer = String(form.get('answer') ?? '')
  const verdict = String(form.get('verdict') ?? '')
  const note = form.get('note') ? String(form.get('note')) : undefined

  if (!question || !answer || (verdict !== 'correct' && verdict !== 'wrong')) {
    return new Response('bad request', { status: 400 })
  }

  const db = getDb()
  await db.insert(answerReviews).values({ id: randomUUID(), question, answer, verdict, note: note ?? null })

  if (verdict === 'wrong' && note) {
    const config = getCurrentConfig()
    await saveLearnedAnswer(config.profileFiles.profile, question, note)
    logger.info({ question, note }, 'dashboard: corrected learned answer')
  }

  return new Response(null, { status: 303, headers: { Location: '/review' } })
}

async function handleRetry(req: Request): Promise<Response> {
  const form = await req.formData()
  const jobId = String(form.get('jobId') ?? '')
  const question = String(form.get('question') ?? '')
  const answer = String(form.get('answer') ?? '')

  if (!jobId || !question || !answer) {
    return new Response('bad request', { status: 400 })
  }

  const config = getCurrentConfig()
  await retryWithAnswer(jobId, question, answer, config.profileFiles.profile)

  return new Response(null, { status: 303, headers: { Location: '/applications' } })
}

/** Plain requeue for a 'blocked' failure (broken page, navigation error,
 * anything that isn't a specific unanswered question) — no answer to collect. */
async function handleRetryJob(req: Request): Promise<Response> {
  const form = await req.formData()
  const jobId = String(form.get('jobId') ?? '')
  if (!jobId) return new Response('bad request', { status: 400 })

  await retryJob(jobId)

  return new Response(null, { status: 303, headers: { Location: '/applications' } })
}

/** External jobs have no apply automation — the human applies manually on the
 * source site and comes back here to record it, so the list can be filtered
 * down to what's still outstanding. */
async function handleMarkExternalApplied(req: Request): Promise<Response> {
  const form = await req.formData()
  const jobId = String(form.get('jobId') ?? '')
  if (!jobId) return new Response('bad request', { status: 400 })

  const db = getDb()
  await db.update(jobs).set({ status: 'applied', updatedAt: new Date() }).where(eq(jobs.id, jobId))

  return new Response(null, { status: 303, headers: { Location: '/external-jobs' } })
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname === '/') return renderSummary()
  if (req.method === 'GET' && url.pathname === '/applications') return renderApplications()
  if (req.method === 'POST' && url.pathname === '/applications/retry') return handleRetry(req)
  if (req.method === 'POST' && url.pathname === '/applications/retry-job') return handleRetryJob(req)
  if (req.method === 'GET' && url.pathname === '/external-jobs') return renderExternalJobs()
  if (req.method === 'POST' && url.pathname === '/external-jobs/mark-applied') return handleMarkExternalApplied(req)
  if (req.method === 'GET' && url.pathname === '/review') return renderReview()
  if (req.method === 'POST' && url.pathname === '/review/generate') return handleGenerate()
  if (req.method === 'POST' && url.pathname === '/review/cluster-feedback') return handleClusterFeedback(req)
  if (req.method === 'GET' && url.pathname === '/career-pages') return renderCareerPages()
  if (req.method === 'POST' && url.pathname === '/review/feedback') return handleFeedback(req)
  return new Response('not found', { status: 404 })
}

let server: ReturnType<typeof Bun.serve> | null = null

export function startDashboard(): void {
  if (server) return
  const port = Number(process.env.DASHBOARD_PORT) || 4870
  try {
    // Bind loopback only — this serves the user's application history and
    // personal answers; it must never be reachable from the LAN.
    server = Bun.serve({ port, hostname: '127.0.0.1', fetch: handleRequest })
    logger.info({ port }, 'dashboard: listening')
  } catch (err) {
    // A busy port must not take the whole app down — the dashboard is optional.
    logger.error({ err, port }, 'dashboard: failed to start (port in use?) — continuing without it')
  }
}

export function stopDashboard(): void {
  server?.stop(true)
  server = null
}
