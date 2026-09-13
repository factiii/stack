import { TRPCError } from '@trpc/server';

import type { AuthUser, CreateUserData } from '../adapters/database';
import type { ResolvedAuthConfig } from './config';
import { sameIdentifier } from './emailMatch';

/** Fresh usernames one account creation tries before it gives up. */
export const MAX_USERNAME_TRIES = 5;

/**
 * Which unique index a failed insert hit, as Prisma (P2002) or node-postgres
 * (23505) reports it: `null` when the error is not a unique violation at all, and
 * `'unknown'` when it is one but names no field this code recognises.
 */
export type UniqueViolationField = 'email' | 'username' | 'other' | 'unknown';

export function uniqueViolationField(err: unknown): UniqueViolationField | null {
  const e = err as {
    code?: unknown;
    message?: unknown;
    meta?: unknown;
    constraint?: unknown;
    detail?: unknown;
  } | null;
  if (e?.code !== 'P2002' && e?.code !== '23505') return null;

  // Prisma puts the fields in `meta` (`target`, or a driver adapter's nested
  // cause) and in the message; node-postgres names the constraint and the key.
  let meta = '';
  try {
    meta = e.meta === undefined || e.meta === null ? '' : JSON.stringify(e.meta);
  } catch {
    meta = '';
  }
  const named = [meta, e.constraint, e.detail]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  const text = `${named} ${typeof e.message === 'string' ? e.message.toLowerCase() : ''}`;

  // `username` first: `email` never appears inside it.
  if (text.includes('username')) return 'username';
  if (text.includes('email')) return 'email';
  // A named index that is neither is some other constraint. A bare message
  // ("duplicate key value violates unique constraint") names nothing.
  return named.trim() ? 'other' : 'unknown';
}

/**
 * Create an account under a generated username, trying a fresh one when the
 * username is taken. An email violation, or a violation of any other index, is
 * rethrown for the caller: it is not a username problem, and only the caller
 * knows whether a lost email race can be recovered.
 */
export async function createUserWithFreshUsername(
  config: ResolvedAuthConfig,
  data: Omit<CreateUserData, 'username'>,
  context: { ip?: string } = {}
): Promise<AuthUser> {
  let lastError: unknown;
  for (let tries = 1; tries <= MAX_USERNAME_TRIES; tries += 1) {
    try {
      return await config.database.user.create({ ...data, username: config.generateUsername() });
    } catch (err) {
      const field = uniqueViolationField(err);
      if (field === null || field === 'email' || field === 'other') throw err;
      if (field === 'unknown') {
        // The error named no index. An account already holding this exact address
        // means it was the email index; otherwise the username was taken.
        const holder = await config.database.user.findByEmailInsensitive(data.email);
        if (holder && sameIdentifier(holder.email, data.email)) throw err;
      }
      lastError = err;
    }
  }

  const error = lastError instanceof Error ? lastError : new Error(String(lastError));
  const description = `createUser: no free username after ${MAX_USERNAME_TRIES} tries: ${error.message}`;
  if (config.hooks?.logError) {
    await config.hooks
      .logError({ type: 'OTHER', description, stack: error.stack ?? '', ip: context.ip })
      .catch(() => undefined);
  } else {
    console.error(`@factiii/auth: ${description}`, error);
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Could not create the account. Try again.',
    cause: error,
  });
}
