/**
 * Tests for canReach() - the routing decision maker
 *
 * canReach() determines HOW each stage is reached:
 * - dev: always local
 * - secrets: needs vault password
 * - staging/prod: SSH key → 'ssh', GITHUB_TOKEN → 'workflow', neither → unreachable
 */
import * as os from 'os';
import * as path from 'path';

// Track which files "exist" in our mock
let mockExistingFiles: Set<string> = new Set();

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => {
      const filePath = String(p).replace(/\\/g, '/');
      for (const mock of mockExistingFiles) {
        if (mock.replace(/\\/g, '/') === filePath) return true;
      }
      return false;
    },
    readFileSync: actual.readFileSync,
  };
});

jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
  spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

import FactiiiPipeline from '../src/plugins/pipelines/factiii/index';
import type { FactiiiConfig } from '../src/types/index';

function mockSshKey(keyName: string): void {
  const keyPath = path.join(os.homedir(), '.ssh', keyName).replace(/\\/g, '/');
  mockExistingFiles.add(keyPath);
}

function mockFile(filePath: string): void {
  mockExistingFiles.add(filePath.replace(/\\/g, '/'));
}

const baseConfig: FactiiiConfig = {
  name: 'test-app',
  ansible: {
    vault_path: './vault/secrets.yml',
    vault_password_file: '~/.vault_pass',
  },
  staging: {
    server: 'ubuntu',
    domain: 'staging.example.com',
  },
  production: {
    server: 'ubuntu',
    domain: 'prod.example.com',
  },
} as FactiiiConfig;

beforeEach(() => {
  mockExistingFiles = new Set();
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_TOKEN;
  delete process.env.FACTIII_ON_SERVER;
  delete process.env.ANSIBLE_VAULT_PASSWORD;
  delete process.env.ANSIBLE_VAULT_PASSWORD_FILE;
});

describe('canReach - dev stage', () => {
  test('dev is always reachable locally', () => {
    const result = FactiiiPipeline.canReach('dev', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('local');
    }
  });
});

describe('canReach - secrets stage', () => {
  test('unreachable when no vault config', () => {
    const configNoVault = { name: 'test' } as FactiiiConfig;
    const result = FactiiiPipeline.canReach('secrets', configNoVault);
    expect(result.reachable).toBe(false);
  });

  test('reachable when vault password file exists', () => {
    const vaultPassPath = path.join(os.homedir(), '.vault_pass').replace(/\\/g, '/');
    mockFile(vaultPassPath);
    const result = FactiiiPipeline.canReach('secrets', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('local');
    }
  });

  test('reachable when ANSIBLE_VAULT_PASSWORD env is set', () => {
    process.env.ANSIBLE_VAULT_PASSWORD = 'test-password';
    const result = FactiiiPipeline.canReach('secrets', baseConfig);
    expect(result.reachable).toBe(true);
  });

  test('unreachable when no vault password available', () => {
    const result = FactiiiPipeline.canReach('secrets', baseConfig);
    expect(result.reachable).toBe(false);
  });
});

describe('canReach - staging/prod stages', () => {
  test('returns local when GITHUB_ACTIONS is set (on server)', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('local');
    }
  });

  test('returns local when FACTIII_ON_SERVER is set', () => {
    process.env.FACTIII_ON_SERVER = 'true';
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('local');
    }
  });

  test('returns ssh when staging SSH key exists', () => {
    mockSshKey('staging_deploy_key');
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('ssh');
    }
  });

  test('returns ssh when prod SSH key exists', () => {
    mockSshKey('prod_deploy_key');
    const result = FactiiiPipeline.canReach('prod', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('ssh');
    }
  });

  test('returns unreachable when only generic key exists (no stage-specific fallback)', () => {
    mockSshKey('id_ed25519');
    // Implementation only accepts stage-specific keys (staging_deploy_key), not id_ed25519
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toContain('SSH');
    }
  });

  test('unreachable when no SSH key even if GITHUB_TOKEN exists', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toContain('SSH');
    }
  });

  test('unreachable when no SSH key and no GITHUB_TOKEN', () => {
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toContain('SSH');
    }
  });

  test('SSH works regardless of GITHUB_TOKEN presence', () => {
    mockSshKey('staging_deploy_key');
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.via).toBe('ssh');
    }
  });
});
