/**
 * Tests for SSH Helper - the core of the migration
 *
 * Tests SSH key detection and environment config resolution.
 */
import * as os from 'os';
import * as path from 'path';

// Track which files "exist" in our mock
let mockExistingFiles: Set<string> = new Set();

// Mock fs module
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

// Mock child_process to prevent actual SSH calls
jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
  spawnSync: jest.fn(() => ({
    status: 0,
    stdout: 'mock output',
    stderr: '',
  })),
}));

import { findSshKeyForStage, getEnvConfigForStage } from '../src/utils/ssh-helper';
import type { FactiiiConfig } from '../src/types/index';

function mockSshKey(keyName: string): string {
  const keyPath = path.join(os.homedir(), '.ssh', keyName);
  // Store normalized (forward slash) for mock matching
  mockExistingFiles.add(keyPath.replace(/\\/g, '/'));
  // Return native path for comparison (findSshKeyForStage returns native paths)
  return keyPath;
}

beforeEach(() => {
  mockExistingFiles = new Set();
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_TOKEN;
  delete process.env.FACTIII_ON_SERVER;
});

describe('findSshKeyForStage', () => {
  test('finds staging_deploy_key for staging stage', () => {
    const keyPath = mockSshKey('staging_deploy_key');
    expect(findSshKeyForStage('staging')).toBe(keyPath);
  });

  test('finds prod_deploy_key for prod stage', () => {
    const keyPath = mockSshKey('prod_deploy_key');
    expect(findSshKeyForStage('prod')).toBe(keyPath);
  });

  test('finds mac_deploy_key for mac stage', () => {
    const keyPath = mockSshKey('mac_deploy_key');
    expect(findSshKeyForStage('mac')).toBe(keyPath);
  });

  test('returns null when only id_ed25519 exists (no stage-specific fallback)', () => {
    mockSshKey('id_ed25519');
    // Implementation only checks stage-specific keys (staging_deploy_key), not generic keys
    expect(findSshKeyForStage('staging')).toBeNull();
  });

  test('returns null when only id_rsa exists (no generic key fallback)', () => {
    mockSshKey('id_rsa');
    // Implementation only checks stage-specific keys, not generic keys
    expect(findSshKeyForStage('staging')).toBeNull();
  });

  test('prefers stage-specific key over generic key', () => {
    mockSshKey('id_ed25519');
    const stagingKey = mockSshKey('staging_deploy_key');
    expect(findSshKeyForStage('staging')).toBe(stagingKey);
  });

  test('returns null when no SSH key exists', () => {
    expect(findSshKeyForStage('staging')).toBeNull();
  });
});

describe('getEnvConfigForStage', () => {
  const mockConfig: FactiiiConfig = {
    name: 'test-app',
    staging: {
      server: 'ubuntu',
      domain: 'staging.example.com',
      ssh_user: 'deploy',
    },
    production: {
      server: 'ubuntu',
      domain: 'prod.example.com',
      ssh_user: 'root',
    },
  } as FactiiiConfig;

  test('finds staging environment config', () => {
    const config = getEnvConfigForStage('staging', mockConfig);
    expect(config).not.toBeNull();
    expect(config!.domain).toBe('staging.example.com');
    expect(config!.ssh_user).toBe('deploy');
  });

  test('finds production environment config', () => {
    const config = getEnvConfigForStage('prod', mockConfig);
    expect(config).not.toBeNull();
    expect(config!.domain).toBe('prod.example.com');
    expect(config!.ssh_user).toBe('root');
  });

  test('returns null for unconfigured stage', () => {
    const config = getEnvConfigForStage('dev', mockConfig);
    expect(config).toBeNull();
  });

  test('returns null for empty config', () => {
    const emptyConfig = { name: 'test' } as FactiiiConfig;
    const config = getEnvConfigForStage('staging', emptyConfig);
    expect(config).toBeNull();
  });
});
