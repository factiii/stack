import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadAwsCredentials,
  getLoadedCredentials,
  clearLoadedCredentials,
} from '../src/plugins/pipelines/aws/utils/aws-helpers';
import type { FactiiiConfig } from '../src/types/config';

describe('loadAwsCredentials', () => {
  afterEach(() => clearLoadedCredentials());

  test('throws when config has no ansible.vault_path', async () => {
    const config = { name: 'test', aws: { access_key_id: 'AKIA' } } as FactiiiConfig;
    await expect(loadAwsCredentials(config, process.cwd())).rejects.toThrow(/vault/i);
  });

  test('is idempotent — second call is a no-op when cache is populated', async () => {
    // Pre-populate via setLoadedCredentials so we don't need a real vault
    const { setLoadedCredentials } = await import('../src/plugins/pipelines/aws/utils/aws-helpers');
    setLoadedCredentials({ accessKeyId: 'AKIA', secretAccessKey: 'S', region: 'us-east-1' });
    const config = { name: 'test' } as FactiiiConfig;
    await loadAwsCredentials(config, process.cwd()); // should not throw, should not re-load
    expect(getLoadedCredentials().accessKeyId).toBe('AKIA');
  });
});
