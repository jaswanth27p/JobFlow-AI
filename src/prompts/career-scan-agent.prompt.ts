import { loadResume, loadProfile, withoutPhone } from '../profile/loader.ts'
import { getCurrentConfig } from '../config/current.ts'

export async function buildPageScanInstructions(pageUrl: string, pageLabel: string): Promise<string> {
  const config = getCurrentConfig()
  const resume = await loadResume(config.profileFiles.resume)
  const profile = withoutPhone(await loadProfile(config.profileFiles.profile))

  return `
You are scanning "${pageLabel}"'s external career/jobs listing page (${pageUrl}) in a real,
already-open browser tab. This is NOT LinkedIn — every site's layout is different, so find the
postings list however this particular page structures it (a table, a list of cards, an embedded
job board widget, etc).

Candidate resume:
${resume}

Candidate profile (structured):
${JSON.stringify(profile, null, 2)}

Hiring requirements to match against:
${config.requirements}

CRITICAL RULE: report-posting-verdict is the ONLY way a posting is recorded. If you judge a posting
and do NOT call report-posting-verdict for it, that judgment is silently lost. Only call it for a
posting check-posting-seen did NOT flag as already seen — a seen posting must not be re-judged.

Process:
1. Take a browser_snapshot (interactiveOnly: true unless you need descriptive text) to find the
   postings list on the page.
2. For each posting: get its apply link first (the URL a candidate would land on to actually apply —
   construct the full absolute URL if the page only shows a relative href), then call
   check-posting-seen with that applyUrl BEFORE reading anything else about the posting. If seen is
   true, skip it entirely — do not read its detail, do not judge it, move to the next posting. This
   matters: re-judging an already-seen posting wastes effort for no benefit, since it's already
   recorded.
3. If not seen: read its title, company (usually "${pageLabel}" itself, but use whatever the page
   actually states), location if shown, and enough of the description to judge it — either from an
   already-visible summary/card, or by opening its detail (click or navigate) if the page requires
   that to see real content.
4. Judge relevance by substance, not literal title match: a posting counts as relevant if its real
   responsibilities/stack overlap meaningfully with the candidate's actual skills and experience,
   even if the title differs. Still respect the requirements text's hard constraints (seniority,
   location, experience range).
5. Call report-posting-verdict with title, company, location, applyUrl, verdict ("relevant" or
   "skip"), and a short reason.
6. If there's pagination or a "load more" control and you haven't yet covered all postings, use it
   and continue from step 1 for the newly-loaded postings.
7. If you hit a login wall, CAPTCHA, or a page structure you genuinely cannot make sense of, call
   request-human-input with a clear question, then continue once answered.

Be economical: an already-seen posting costs you one check-posting-seen call and nothing else — no
detail read, no judgment. Don't take a fresh browser_snapshot unless the visible content actually
changed (new page, new postings loaded).

Work through every posting visible on this page (and any further pages/loads it offers) before
finishing your turn.
`.trim()
}
