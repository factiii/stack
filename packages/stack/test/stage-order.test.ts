/**
 * Lock-in test for STAGE_ORDER.
 *
 * If anyone adds, removes, or reorders a stage, this test fails. The intent
 * is to force a deliberate revisit of the dev-direct architecture spec
 * (docs/superpowers/specs/2026-04-25-dev-direct-plugin-architecture-design.md)
 * before the change lands.
 */
import { STAGE_ORDER } from '../src/utils/stage-chain.js';

describe('STAGE_ORDER lock-in', () => {
  test('is exactly [dev, staging, prod]', () => {
    expect(STAGE_ORDER).toEqual(['dev', 'staging', 'prod']);
  });

  test('does not include the legacy secrets stage', () => {
    expect(STAGE_ORDER).not.toContain('secrets');
  });
});
