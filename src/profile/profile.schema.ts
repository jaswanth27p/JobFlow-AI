import { z } from 'zod'

export const profileSchema = z.object({
  contact: z.object({
    email: z.string().email(),
    phone: z.string(),
    location: z.string(),
  }),
  workAuth: z.object({
    authorized: z.boolean(),
    requiresSponsorship: z.boolean(),
  }),
  experienceYears: z.number().nonnegative(),
  salaryExpectation: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
    currency: z.string(),
  }),
  links: z.object({
    linkedin: z.string(),
    github: z.string(),
    portfolio: z.string(),
  }),
  answers: z.record(z.string(), z.string()).default({}),
  /** Free-text notes added mid-run via /add-context (easy-apply tab) — things
   * the user wants the apply agent to know that don't fit the structured
   * fields above (e.g. "I'm open to relocating to Bangalore now" or "skip any
   * job asking for a portfolio video"). Read fresh per job like the rest of
   * profile.json, so a note added while the queue is running applies to every
   * job processed after that point, not just future runs. */
  additionalContext: z.array(z.string()).default([]),
})

export type ProfileData = z.infer<typeof profileSchema>
