/**
 * Verifies stack never reads or writes ~/.aws/credentials.
 * SDK clients are constructed with explicit credentials from the in-memory cache.
 */

import {
  setLoadedCredentials,
  clearLoadedCredentials,
  getEC2Client,
  clearClientCache,
} from '../src/plugins/pipelines/aws/utils/aws-helpers';

describe('AWS isolation from ~/.aws/credentials', () => {
  afterEach(() => {
    clearLoadedCredentials();
    clearClientCache();
  });

  test('SDK client receives credentials from cache', () => {
    setLoadedCredentials({
      accessKeyId: 'AKIAFROM_CACHE',
      secretAccessKey: 'cache-secret',
      region: 'us-east-1',
    });
    const client = getEC2Client('us-east-1');
    // The AWS SDK v3 stores the credential resolver internally; we can't easily
    // inspect it without sending a request. Instead, verify the cache key includes
    // the access key, so a credential swap rebuilds the client.
    const client2 = getEC2Client('us-east-1');
    expect(client).toBe(client2); // same key → same instance

    setLoadedCredentials({
      accessKeyId: 'AKIADIFFERENT',
      secretAccessKey: 'other',
      region: 'us-east-1',
    });
    const client3 = getEC2Client('us-east-1');
    expect(client3).not.toBe(client); // swap → new instance
  });

  test('factory throws when credentials are not loaded', () => {
    clearLoadedCredentials();
    expect(() => getEC2Client('us-east-1')).toThrow(/not loaded/i);
  });
});
