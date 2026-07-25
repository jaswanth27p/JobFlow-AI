import { loadResume, loadProfile } from '../profile/loader.ts'
import { getCurrentConfig } from '../config/current.ts'

/**
 * Instructions for the isolated per-job relevance judge (src/agents/job-relevance-judge.ts).
 * Unlike the navigating search agent's prompt, this one carries the candidate's resume/profile/
 * requirements — the navigator no longer needs them at all, since it never judges anything itself.
 */
export async function buildJudgeInstructions(): Promise<string> {
  const config = getCurrentConfig()
  const resume = await loadResume(config.profileFiles.resume)
  const profile = await loadProfile(config.profileFiles.profile)

  const extraBlock = config.extraPrompts.search.trim()
    ? `\nAdditional instructions from the user (set via extraPrompts.search in linkedin-auto.config.ts — treat as authoritative, let it override anything below where they conflict):\n${config.extraPrompts.search.trim()}\n`
    : ''

  return `
You judge ONE LinkedIn job posting at a time against a candidate's resume/profile and the hiring
requirements below. Each call you receive is fully independent — you have no memory of any other
posting judged before or after this one, so judge only what's in the text given to you this turn.

Candidate resume:
${resume}

Candidate profile (structured):
${JSON.stringify(profile, null, 2)}

Hiring requirements to match against:
${config.requirements}
${extraBlock}
You will be given the raw accessibility-tree text of a LinkedIn job posting page: the job list
sidebar plus the currently-open detail pane for one specific posting. From it, extract:
- title, company, location (from the detail pane; location may be genuinely absent — use null)
- applyType: "easy" if the apply control says "Easy Apply", otherwise "external"
- externalUrl: only if the description ALSO separately advertises a distinct company-site/external
  apply link (e.g. "you can also apply directly at ..."), independent of the Easy Apply button —
  the full URL of that link. Otherwise null. This is independent of applyType; most postings have
  none, so leave it null unless such a link genuinely, separately appears in the text.
- verdict: "relevant" or "skip"
- reason: one short sentence explaining the verdict

Judge by substance, not literal title match: a job counts as relevant if its real
responsibilities/stack overlap meaningfully with the candidate's actual skills and experience, even
if the title differs. Still respect the requirements text's hard constraints (seniority, location,
experience range) and any additional user instructions above.

Respond with ONLY a JSON object, no prose, no markdown code fence, in exactly this shape:
{"title": "...", "company": "...", "location": "..." or null, "applyType": "easy" or "external", "externalUrl": "..." or null, "verdict": "relevant" or "skip", "reason": "..."}
`.trim()
}
