import { loadResume, loadProfile, withoutPhone } from '../profile/loader.ts'
import type { AppConfig } from '../config/schema.ts'

export interface ApplyJobRecord {
  id: string
  title: string
  company: string
  applyUrl: string
}

export async function buildApplyInstructions(config: AppConfig, job: ApplyJobRecord): Promise<string> {
  const resume = await loadResume(config.profileFiles.resume)
  const { additionalContext, ...rest } = await loadProfile(config.profileFiles.profile)
  const profile = withoutPhone(rest)

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
2. The form opens in a modal dialog on top of the job page, with its own internal scroll area. These scroll
   rules are the difference between moving the form and accidentally moving the page behind it:
   a. Never call browser_scroll with only a direction and no ref. That calls window.scrollBy on the whole
      page behind the modal, so the underlying job page slides around while the form stays put. This is the
      exact bug that makes the modal look frozen.
   b. To reveal an element that is scrolled out of view inside the modal, call browser_scroll with the ref of
      that element (or of a field/button next to it), taken from your latest browser_snapshot. A ref-based
      scroll carries the modal's own scroll container to the element — this is the only supported way to
      scroll the form. Clicking an element also scrolls it into view on its own, so try the click first.
   c. browser_scroll's own result reports the PAGE's scroll position, not the modal's, so it tells you
      nothing useful here. To confirm what is now visible, take a fresh browser_snapshot.
3. Work from a fresh browser_snapshot on every step — it is the source of truth for which fields exist and
   what they contain, not these instructions. Before clicking Next/Review/Submit, re-snapshot and make sure
   every required field in the current step is filled. Treat a field as required if it has an asterisk,
   aria-required="true", the word "required", or a red error message under it. Fill comboboxes/autocomplete
   fields by typing and then picking a value from the dropdown list that appears; fill radios and selects by
   actually selecting an option — never leave these at a default or blank.
4. For each field/question, resolve its value in this order:
   a. If the field asks for a phone number, call get-phone-number and use the returned value. Do not guess, reuse a number seen elsewhere, or leave it blank — this is the only source for it, deliberately kept out of your instructions above.
   b. Otherwise, if it maps directly to a structured profile field above (email, location, work authorization, salary expectation, years of experience, links), use that value directly.
   c. Otherwise, call lookup-learned-answer with the exact on-page question text. If found is true, use that answer.
   d. Otherwise, if you can confidently infer the answer from the resume/profile content, answer it yourself.
   e. Otherwise — a genuine unknown — call ask-human-and-remember with the question, then use the returned answer.
   f. Regardless of which path (a-e) you used, call record-answer with the question, the answer you used, and which path resolved it (source: "profile", "learned", "inferred", or "human"). This is mandatory for EVERY field — it is the only record of what was actually submitted, for later human review. Do this before moving to the next field.
5. After every click on Next/Review/Submit, take a new browser_snapshot immediately and read it for validation
   errors before doing anything else — inline red text such as "This is required", "Please enter a valid
   answer", "Please select an option", aria-invalid, or a field highlighted in red. If any error is present:
   a. Do not click Next/Review/Submit again until you have filled the flagged field(s).
   b. Match each error to its field, resolve its value with the same a-f order above, and record-answer it.
   c. Then click Next/Review/Submit again and re-snapshot. A step is only complete once it advances with no
      validation errors.
   d. If the same step still shows validation errors after three attempts, stop clicking it. Call
      report-submission with success: false, reason: "missing_info", and question set to the exact text of
      the field that will not validate — do not keep clicking Next or scrolling.
6. Never repeat the same action (the same click, or the same scroll to the same ref) more than twice in a row
   without a visible change in the snapshot. If the snapshot is unchanged, change approach — click a
   different element, dismiss any autocomplete/date-picker overlay with Escape, take a new snapshot, or
   escalate — rather than looping. Scrolling is only for revealing a specific element, never a way to
   "look around" the form.
7. If the form has a resume step, LinkedIn Easy Apply reuses a resume already uploaded to the candidate's LinkedIn account — it will be pre-selected automatically. Just confirm/continue past that step; do not try to upload a file. Only if the step shows no resume at all and forces a fresh upload with no way to proceed, call ask-human-and-remember asking the human to attach one manually in the visible browser, then continue once they confirm.
8. Submit the application once all steps are complete and no validation errors remain.
9. Call report-submission with success: true after a successful submission. If you get stuck in a way you cannot resolve, call it with success: false and one of:
   - reason: "missing_info", question: "<the exact on-page question text>" — only if you truly could not get an answer for a specific required field (e.g. ask-human-and-remember's answer still didn't satisfy the form's validation). The app asks the human that one question immediately and retries this application right away — no separate command needed.
   - reason: "blocked" (or omit reason) — for anything else: broken page, unexpected error, application form crashed. This is not auto-retryable, so only use "missing_info" when you can name the exact question.
   Call report-submission exactly once, at the very end.
`.trim()
}
