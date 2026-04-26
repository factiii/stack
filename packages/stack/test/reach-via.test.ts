/**
 * Lock-in test for ReachVia.
 *
 * The dev-direct architecture (docs/superpowers/specs/2026-04-25-dev-direct-plugin-architecture-design.md)
 * reduces routing to a single execution context: the dev machine. Every
 * canReach() returns either { reachable: true, via: 'local' } or
 * { reachable: false }. If anyone re-adds 'ssh' / 'workflow' / 'api' /
 * 'github-api' to the union, this file fails to compile.
 *
 * Type-only test — there is nothing to assert at runtime beyond the placeholder.
 */
import type { ReachVia, Reachability } from '../src/types/index.js';

// Compile-time assertion: ReachVia is exactly 'local'.
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ReachViaIsExactlyLocal = Assert<Equals<ReachVia, 'local'>>;

// Compile-time assertion: a Reachability value cannot be constructed with
// any disallowed via values. The @ts-expect-error directives MUST trigger;
// if any does not, the test is broken (the directive itself errors).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _disallowed: Reachability[] = [
  // @ts-expect-error 'ssh' is no longer a valid ReachVia
  { reachable: true, via: 'ssh' },
  // @ts-expect-error 'workflow' is no longer a valid ReachVia
  { reachable: true, via: 'workflow' },
  // @ts-expect-error 'api' is no longer a valid ReachVia
  { reachable: true, via: 'api' },
  // @ts-expect-error 'github-api' is no longer a valid ReachVia
  { reachable: true, via: 'github-api' },
];

describe('ReachVia lock-in (compile-time only)', () => {
  test('placeholder — real assertions are in the type system above', () => {
    expect(true).toBe(true);
  });
});
