import { loadResume, loadProfile } from '../profile/loader.ts'
import type { AppConfig } from '../config/schema.ts'

export interface ApplyJobRecord {
  id: string
  title: string
  company: string
  applyUrl: string
}

export async function buildApplyInstructions(config: AppConfig, job: ApplyJobRecord): Promise<string> {
  const resume = await loadResume(config.profileFiles.resume)
  const { additionalContext, ...profile } = await loadProfile(config.profileFiles.profile)

  const additionalContextBlock =
    additionalContext.length > 0
      ? `\nAdditional context from the user (added via /add-context — read fresh for every job, so this may include notes added mid-run; treat it as authoritative and let it override the resume/profile below where they conflict):\n${additionalContext.map((note) => `- ${note}`).join('\n')}\n`
      : ''

  const extraBlock = config.extraPrompts.easyApply.trim()
    ? `\nAdditional instructions from the user (set via extraPrompts.easyApply in linkedin-auto.config.ts — treat as authoritative, let it override anything below where they conflict):\n${config.extraPrompts.easyApply.trim()}\n`
    : ''

  return `
You are filling out a LinkedIn Easy Apply form in a real, already-logged-in browser.

Job: ${job.title} @ ${job.company}
Apply URL: ${job.applyUrl}

Candidate resume:
${resume}

Candidate profile (structured):
${JSON.stringify(profile, null, 2)}
${additionalContextBlock}${extraBlock}
You are already on the job's apply page, in your own dedicated browser tab that the app opened for
you. Do not use any tab-management action — there isn't one available to you, and there doesn't need
to be; the app owns opening/closing this tab for the whole application, including retries.

Steps:
1. Click "Easy Apply" on the current page.
2. Step through the form. For each field/question, resolve it in this order:
   a. If it maps directly to a structured profile field above (contact info, work authorization, salary expectation, years of experience, links), use that value directly.
   b. Otherwise, call lookup-learned-answer with the exact on-page question text. If found is true, use that answer.
   c. Otherwise, if you can confidently infer the answer from the resume/profile content, answer it yourself.
   d. Otherwise — a genuine unknown — call ask-human-and-remember with the question, then use the returned answer.
   e. Regardless of which path (a-d) you used, call record-answer with the question, the answer you used, and which path resolved it (source: "profile", "learned", "inferred", or "human"). This is mandatory for EVERY field — it is the only record of what was actually submitted, for later human review. Do this before moving to the next field.
3. If the form has a resume step, LinkedIn Easy Apply reuses a resume already uploaded to the candidate's LinkedIn account — it will be pre-selected automatically. Just confirm/continue past that step; do not try to upload a file. Only if the step shows no resume at all and forces a fresh upload with no way to proceed, call ask-human-and-remember asking the human to attach one manually in the visible browser, then continue once they confirm.
4. Submit the application once all steps are complete.
5. Call report-submission with success: true after a successful submission. If you get stuck in a way you cannot resolve, call it with success: false and one of:
   - reason: "missing_info", question: "<the exact on-page question text>" — only if you truly could not get an answer for a specific required field (e.g. ask-human-and-remember's answer still didn't satisfy the form's validation). The app asks the human that one question immediately and retries this application right away — no separate command needed.
   - reason: "blocked" (or omit reason) — for anything else: broken page, unexpected error, application form crashed. This is not auto-retryable, so only use "missing_info" when you can name the exact question.
   Call report-submission exactly once, at the very end.
`.trim()
}
