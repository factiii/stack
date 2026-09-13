/**
 * Case-insensitive EXACT matching for emails and usernames.
 *
 * Prisma's `mode: 'insensitive'` `equals` compiles to ILIKE on Postgres, where
 * `_` and `%` are pattern characters. Passed through unescaped, a lookup for one
 * address can return a different account whose address merely fits the pattern.
 * So the adapter escapes the pattern characters, and every caller that acts on a
 * lookup result re-checks it with `sameIdentifier`.
 */

/** The characters LIKE and ILIKE treat specially under the default escape. */
const LIKE_SPECIAL = /[\\%_]/g;

/** True when `value` holds a character a LIKE pattern would not take literally. */
export function hasLikeWildcard(value: string): boolean {
  return /[\\%_]/.test(value);
}

/** Escape `\`, `%` and `_` with a backslash, Postgres's default LIKE escape. */
export function escapeLikePattern(value: string): string {
  return value.replace(LIKE_SPECIAL, (char) => `\\${char}`);
}

/**
 * True when a stored email or username is the same identifier as `input`, with
 * case the only difference allowed. A null or missing stored value never matches.
 */
export function sameIdentifier(stored: string | null | undefined, input: string): boolean {
  return typeof stored === 'string' && stored.toLowerCase() === input.toLowerCase();
}
