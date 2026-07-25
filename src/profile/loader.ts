import { readFile, writeFile } from 'node:fs/promises'
import { profileSchema, type ProfileData } from './profile.schema.ts'

export async function loadResume(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

export async function loadProfile(path: string): Promise<ProfileData> {
  const raw = await readFile(path, 'utf-8')
  return profileSchema.parse(JSON.parse(raw))
}

/** Strips contact.phone before a profile is serialized into any LLM prompt —
 * the phone number must never leave the process as prompt text (training-data/
 * retention risk at the model provider). The one agent that actually needs to
 * fill a phone field (easy-apply) gets it on demand via the get-phone-number
 * tool (easy-apply-agent.ts), which calls loadProfile directly instead of
 * going through this redacted copy. Generic so it works on both the full
 * ProfileData and a profile object that's already had other fields (e.g.
 * additionalContext) destructured out. */
export function withoutPhone<T extends { contact: { phone: string } }>(
  profile: T,
): Omit<T, 'contact'> & { contact: Omit<T['contact'], 'phone'> } {
  const { phone: _phone, ...contact } = profile.contact
  return { ...profile, contact } as Omit<T, 'contact'> & { contact: Omit<T['contact'], 'phone'> }
}

// Serializes read-modify-write cycles against profile.json. Multiple agents
// (search/easy-apply/career-scan) plus the dashboard's HTTP handlers all run
// in this one process and can call saveLearnedAnswer around the same time —
// without this chain, two concurrent calls each read the file before either
// writes, and the second write silently clobbers the first's learned answer.
let writeQueue: Promise<void> = Promise.resolve()

export async function saveLearnedAnswer(path: string, question: string, answer: string): Promise<void> {
  const run = writeQueue.then(async () => {
    const profile = await loadProfile(path)
    profile.answers[question] = answer
    await writeFile(path, JSON.stringify(profile, null, 2))
  })
  // Keep the queue alive even if this write fails, but let the failure
  // surface to this call's own caller.
  writeQueue = run.catch(() => {})
  await run
}

/** Appends a free-text note to profile.json's additionalContext — see
 * /add-context (easy-commands.ts). Same read-modify-write queue as
 * saveLearnedAnswer, guarding against the same lost-write race. */
export async function saveAdditionalContext(path: string, note: string): Promise<void> {
  const run = writeQueue.then(async () => {
    const profile = await loadProfile(path)
    profile.additionalContext.push(note)
    await writeFile(path, JSON.stringify(profile, null, 2))
  })
  writeQueue = run.catch(() => {})
  await run
}
