/**
 * Tests that AWS credentials (env vars) are cleaned up after use.
 *
 * Verifies that writeAwsCredentials sets env vars and clearAwsCredentials
 * removes them, ensuring no credential leakage between runs.
 */

// Mock fs so we don't write to actual ~/.aws/credentials
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => {
      if (String(p).includes('.aws/credentials')) return true;
      return actual.existsSync(p);
    },
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

import {
  writeAwsCredentials,
  clearAwsCredentials,
  clearClientCache,
  getLocalAccessKeyId,
} from '../src/plugins/pipelines/aws/utils/aws-helpers';

describe('AWS credentials cleanup', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_DEFAULT_REGION;
    clearClientCache();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('writeAwsCredentials sets env vars', () => {
    writeAwsCredentials('AKIATEST123', 'secret123', 'us-east-1');

    expect(process.env.AWS_ACCESS_KEY_ID).toBe('AKIATEST123');
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('secret123');
    expect(process.env.AWS_DEFAULT_REGION).toBe('us-east-1');
  });

  test('clearAwsCredentials removes env vars', () => {
    // Set credentials first
    writeAwsCredentials('AKIATEST456', 'secret456', 'us-west-2');
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('AKIATEST456');

    // Clear them
    clearAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
  });

  test('clearAwsCredentials works even if no credentials were set', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    // Should not throw
    expect(() => clearAwsCredentials()).not.toThrow();

    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test('credentials are not leaked between write/clear cycles', () => {
    // First cycle
    writeAwsCredentials('AKIA_FIRST', 'secret_first', 'us-east-1');
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('AKIA_FIRST');

    clearAwsCredentials();
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();

    // Second cycle with different credentials
    writeAwsCredentials('AKIA_SECOND', 'secret_second', 'eu-west-1');
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('AKIA_SECOND');
    expect(process.env.AWS_DEFAULT_REGION).toBe('eu-west-1');

    clearAwsCredentials();
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
