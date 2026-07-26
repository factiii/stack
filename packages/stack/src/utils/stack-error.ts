/**
 * StackError — a typed error taxonomy so scripts and AI agents can branch on
 * WHY a command failed via a stable code + exit code, instead of scraping prose.
 *
 * Exit codes (read by wrapping scripts / CI / agents):
 *   1 FAILED       generic failure
 *   2 NEEDS_INPUT  a value is required but none was supplied (and we're non-interactive)
 *   3 UNREACHABLE  a target (staging/prod server, AWS, network) could not be reached
 *   4 VALIDATION   config / input / scan findings block the operation
 *
 * CLI-layer only. Never thrown from inside a scanfix `scan`/`fix` (per STANDARDS).
 */

export type StackErrorCode = 'FAILED' | 'NEEDS_INPUT' | 'UNREACHABLE' | 'VALIDATION';

const EXIT_CODE: Record<StackErrorCode, number> = {
  FAILED: 1,
  NEEDS_INPUT: 2,
  UNREACHABLE: 3,
  VALIDATION: 4,
};

export class StackError extends Error {
  readonly code: StackErrorCode;
  readonly exitCode: number;
  /** One-line actionable next step (e.g. which env var / flag to supply). */
  readonly hint?: string;
  /** Optional machine-readable context for --json consumers. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: StackErrorCode,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'StackError';
    this.code = code;
    this.exitCode = EXIT_CODE[code];
    this.hint = opts.hint;
    this.details = opts.details;
    // Restore prototype chain (TS targeting ES5/ES2015 with extends Error).
    Object.setPrototypeOf(this, StackError.prototype);
  }

  /** A required value was not supplied and we cannot prompt for it. */
  static needsInput(message: string, hint?: string): StackError {
    return new StackError('NEEDS_INPUT', message, { hint });
  }

  static unreachable(message: string, hint?: string): StackError {
    return new StackError('UNREACHABLE', message, { hint });
  }

  static validation(message: string, hint?: string): StackError {
    return new StackError('VALIDATION', message, { hint });
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isStackError(e: unknown): e is StackError {
  return e instanceof StackError || (e instanceof Error && e.name === 'StackError');
}
