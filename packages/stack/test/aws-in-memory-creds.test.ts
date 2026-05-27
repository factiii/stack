import {
  setLoadedCredentials,
  clearLoadedCredentials,
  getLoadedCredentials,
  verifyCredentialsWithSts,
} from '../src/plugins/pipelines/aws/utils/aws-helpers';

describe('AWS in-memory credentials', () => {
  afterEach(() => clearLoadedCredentials());

  test('getLoadedCredentials throws before load', () => {
    expect(() => getLoadedCredentials()).toThrow(/not loaded/i);
  });

  test('setLoadedCredentials populates cache', () => {
    setLoadedCredentials({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      region: 'us-east-1',
    });
    expect(getLoadedCredentials().accessKeyId).toBe('AKIATEST');
  });

  test('clearLoadedCredentials empties cache', () => {
    setLoadedCredentials({ accessKeyId: 'A', secretAccessKey: 'B', region: 'us-east-1' });
    clearLoadedCredentials();
    expect(() => getLoadedCredentials()).toThrow();
  });

  test('verifyCredentialsWithSts is callable as a pure function', () => {
    // Smoke test only — does not hit AWS. Just verify the function shape.
    expect(typeof verifyCredentialsWithSts).toBe('function');
  });
});
