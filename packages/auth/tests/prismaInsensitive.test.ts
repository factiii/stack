/**
 * The Prisma adapter's case-insensitive lookups must be EXACT.
 *
 * Postgres turns Prisma's `mode: 'insensitive'` `equals` into ILIKE, where `_` and
 * `%` are wildcards. A lookup for `j_hn@outlook.com` that returns
 * `john@outlook.com` hands John's account to whoever owns the look-alike address.
 *
 * No database here: a fake client runs each filter the way an engine would
 * compile it — once as ILIKE (backslash escapes, `_` and `%` wildcards) and once
 * as `LOWER(col) = LOWER($1)` — so the adapter is proven exact under both.
 */
import { describe, expect, it } from 'vitest';

import { createPrismaAdapter } from '../src/adapters/prismaAdapter';

type Row = { id: number; email: string | null; username: string | null };
type Condition = { equals: string; mode?: string };
type Where = Partial<Record<'email' | 'username', Condition>> & { OR?: Where[] };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ILIKE semantics: `\` escapes the next character, `_` is one character, `%` is any run. */
function ilikeToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '\\' && i + 1 < pattern.length) {
      i += 1;
      source += escapeRegExp(pattern[i]!);
    } else if (char === '_') {
      source += '.';
    } else if (char === '%') {
      source += '.*';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, 'is');
}

function fakePrisma(rows: Row[], engine: 'ilike' | 'lower') {
  const matches = (value: string | null, condition: Condition) => {
    if (value === null) return false;
    return engine === 'ilike'
      ? ilikeToRegExp(condition.equals).test(value)
      : value.toLowerCase() === condition.equals.toLowerCase();
  };
  const test = (where: Where) => (row: Row): boolean => {
    if (where.OR) return where.OR.some((clause) => test(clause)(row));
    return (['email', 'username'] as const).every((field) => {
      const condition = where[field];
      return condition ? matches(row[field], condition) : true;
    });
  };
  return {
    user: {
      findFirst: async ({ where }: { where: Where }) => rows.find(test(where)) ?? null,
      findMany: async ({ where, take }: { where: Where; take?: number }) =>
        rows.filter(test(where)).slice(0, take ?? rows.length),
    },
  };
}

const john: Row = { id: 1, email: 'John@Outlook.com', username: 'john' };
const underscored: Row = { id: 2, email: 'j_hn@outlook.com', username: 'j_hn' };

describe.each(['ilike', 'lower'] as const)('Prisma lookups under %s semantics', (engine) => {
  const adapter = (rows: Row[]) => createPrismaAdapter(fakePrisma(rows, engine)).user;

  it('a look-alike address with `_` finds nobody', async () => {
    await expect(adapter([john]).findByEmailInsensitive('j_hn@outlook.com')).resolves.toBeNull();
  });

  it('a `%` in the value finds nobody', async () => {
    await expect(adapter([john]).findByEmailInsensitive('%@outlook.com')).resolves.toBeNull();
  });

  it('still finds the same address in any case', async () => {
    await expect(adapter([john]).findByEmailInsensitive('JOHN@outlook.COM')).resolves.toMatchObject({
      id: 1,
    });
  });

  it('finds an address that really contains `_`, and not its look-alike', async () => {
    await expect(
      adapter([john, underscored]).findByEmailInsensitive('J_HN@outlook.com')
    ).resolves.toMatchObject({ id: 2 });
    await expect(adapter([underscored]).findByEmailInsensitive('j_hn@outlook.com')).resolves.toMatchObject({
      id: 2,
    });
  });

  it('usernames and the email-or-username lookup are exact too', async () => {
    const user = adapter([john]);
    await expect(user.findByUsernameInsensitive('j_hn')).resolves.toBeNull();
    await expect(user.findByEmailOrUsernameInsensitive('j_hn')).resolves.toBeNull();
    await expect(user.findByEmailOrUsernameInsensitive('j_hn@outlook.com')).resolves.toBeNull();
    await expect(user.findByEmailOrUsernameInsensitive('JOHN')).resolves.toMatchObject({ id: 1 });
    await expect(
      adapter([john, underscored]).findByEmailOrUsernameInsensitive('j_hn')
    ).resolves.toMatchObject({ id: 2 });
  });
});
