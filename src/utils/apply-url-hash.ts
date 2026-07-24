import { createHash } from 'node:crypto'

/** Stable id for a posting keyed by its apply URL rather than a site-native id
 * — stays the same across reruns of whatever discovered it, so a dedupe check
 * (check-posting-seen, or a secondary external link found alongside an Easy
 * Apply job) recognizes a URL already recorded, and can't be spoofed/mistyped
 * like a model-supplied id could. */
export function applyUrlToJobId(applyUrl: string): string {
  return createHash('sha1').update(applyUrl.trim()).digest('hex')
}
