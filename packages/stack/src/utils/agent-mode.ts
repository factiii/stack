/**
 * Agent mode — makes the stack CLI scriptable and AI-friendly.
 *
 * Three orthogonal modes, set from global flags (stripped in bin/stack) or env:
 *
 *   --json / STACK_JSON=1
 *       stdout carries ONLY a single final JSON result line; every human/log
 *       line (console.log/info) is redirected to stderr so stdout stays pure.
 *
 *   --non-interactive / STACK_NONINTERACTIVE=1  (also auto-on when stdin is not a TTY)
 *       never prompt. When a value is genuinely required, the prompt throws a
 *       typed NEEDS_INPUT StackError naming what to supply — instead of hanging.
 *
 *   --quiet / STACK_QUIET=1
 *       suppress progress logs (warnings/errors still surface on stderr).
 *
 * Importing this module has no side effects; call initAgentMode() once at
 * startup. It deliberately does NOT import the prompt or command code, so it is
 * safe to import from anywhere (no cycles).
 */

import { StackError, isStackError } from './stack-error.js';

export interface AgentMode {
  json: boolean;
  nonInteractive: boolean;
  quiet: boolean;
}

let mode: AgentMode = { json: false, nonInteractive: false, quiet: false };
let patched = false;

function envFlag(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

/**
 * Initialize agent mode from parsed global flags + environment. Idempotent.
 * Call once, as early as possible (before any command action runs).
 */
export function initAgentMode(
  opts: { json?: boolean; nonInteractive?: boolean; quiet?: boolean } = {}
): AgentMode {
  mode = {
    json: !!opts.json || envFlag(process.env.STACK_JSON),
    nonInteractive:
      !!opts.nonInteractive ||
      envFlag(process.env.STACK_NONINTERACTIVE) ||
      !process.stdin.isTTY,
    // json implies quiet on stdout (logs move to stderr regardless).
    quiet: !!opts.quiet || !!opts.json || envFlag(process.env.STACK_QUIET),
  };

  // Keep stdout clean: route console.log / console.info to stderr (json) or
  // drop them (quiet, non-json). console.warn/error already go to stderr.
  if ((mode.json || mode.quiet) && !patched) {
    patched = true;
    const toStderr = (...args: unknown[]): void => {
      process.stderr.write(args.map((a) => String(a)).join(' ') + '\n');
    };
    const drop = (): void => {};
    const sink = mode.json ? toStderr : drop;
    console.log = sink as typeof console.log;
    console.info = sink as typeof console.info;
  }

  return mode;
}

export function getAgentMode(): AgentMode {
  return mode;
}
export const isJson = (): boolean => mode.json;
export const isNonInteractive = (): boolean => mode.nonInteractive;
export const isQuiet = (): boolean => mode.quiet;

/**
 * Emit the final machine-readable result for a command. No-op unless --json.
 * `ok` plus the command's own structured result is serialized to stdout.
 */
export function emitResult(command: string, ok: boolean, result: unknown): void {
  if (!mode.json) return;
  process.stdout.write(
    JSON.stringify({ ok, command, result: result ?? null }) + '\n'
  );
}

/**
 * Top-level error handler for bin/stack. Maps any error to a stable exit code,
 * and in --json mode emits a structured error envelope on stdout. Never returns.
 */
export function handleTopLevelError(command: string, err: unknown): never {
  const e: StackError = isStackError(err)
    ? (err as StackError)
    : new StackError('FAILED', err instanceof Error ? err.message : String(err));

  if (mode.json) {
    process.stdout.write(
      JSON.stringify({ ok: false, command, error: e.toJSON() }) + '\n'
    );
  } else {
    process.stderr.write('\n✖ ' + e.message + '\n');
    if (e.hint) process.stderr.write('  → ' + e.hint + '\n');
  }
  process.exit(e.exitCode);
}
