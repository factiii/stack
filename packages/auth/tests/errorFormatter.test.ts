import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { createTrpcBuilder } from '../src/utilities/trpc';
import type { ResolvedAuthConfig } from '../src/utilities/config';

function format(
  logError: ReturnType<typeof vi.fn>,
  error: TRPCError,
  path: string | undefined,
) {
  const t = createTrpcBuilder({
    hooks: { logError },
  } as unknown as ResolvedAuthConfig);
  const shape = {
    message: error.message,
    code: -32603,
    data: { code: error.code, httpStatus: 500 },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (t as any)._config.errorFormatter({
    shape,
    error,
    path,
    type: 'query',
    input: undefined,
    ctx: { ip: '1.2.3.4', userId: null },
  });
}

describe('errorFormatter SERVER_ERROR logging', () => {
  // Regression: minified production stacks were unattributable to a procedure
  // (the posts.feed P2025 sat unidentified for weeks). The formatter must
  // prepend the tRPC path to every logged stack.
  it('prefixes logged stacks with the tRPC path', () => {
    const logError = vi.fn().mockResolvedValue(null);
    const err = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' });

    const formatted = format(logError, err, 'posts.feed');

    expect(logError).toHaveBeenCalledTimes(1);
    const { stack, description } = logError.mock.calls[0][0];
    expect(stack.startsWith('Path: posts.feed\n')).toBe(true);
    expect(description).toBe('boom');
    // User-facing message is still sanitized
    expect(formatted.message).toBe(
      'An unexpected error occurred. Please try again later.',
    );
  });

  it('falls back to "unknown" when the path is absent', () => {
    const logError = vi.fn().mockResolvedValue(null);
    const err = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' });

    format(logError, err, undefined);

    expect(logError.mock.calls[0][0].stack.startsWith('Path: unknown\n')).toBe(true);
  });

  it('does not log non-500 errors', () => {
    const logError = vi.fn().mockResolvedValue(null);
    const err = new TRPCError({ code: 'NOT_FOUND', message: 'nope' });

    const formatted = format(logError, err, 'posts.feed');

    expect(logError).not.toHaveBeenCalled();
    expect(formatted.message).toBe('nope');
  });
});
