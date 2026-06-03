/**
 * Tests for SSH Helper - the core of the migration
 *
 * Tests SSH key detection and environment config resolution.
 */
import * as nativePath from 'path';
import * as nativeOs from 'os';

// Must be `var` so it is hoisted above jest.mock() calls.
// The homedir() mock below is only *called* during test execution,
// at which point the var is already assigned by beforeAll.
// eslint-disable-next-line no-var
var fakeHomeOverride: string | undefined;

// Track which files "exist" in our mock
let mockExistingFiles: Set<string> = new Set();

// Mock os.homedir() using the hoisted var
jest.mock('os', () => {
  const actual = jest.requireActual<typeof nativeOs>('os');
  return {
    ...actual,
    homedir: () => fakeHomeOverride ?? actual.homedir(),
  };
});

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
    readFileSync: (p: string, ...args: any[]) => {
      const filePath = String(p).replace(/\\/g, '/');
      for (const mock of mockExistingFiles) {
        if (mock.replace(/\\/g, '/') === filePath) {
          return '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-content\n-----END OPENSSH PRIVATE KEY-----\n';
        }
      }
      return actual.readFileSync(p, ...args);
    },
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

import { findSshKeyForStage, findProdPemKey, getEnvConfigForStage } from '../src/utils/ssh-helper';
import type { FactiiiConfig } from '../src/types/index';

const FAKE_HOME = nativePath.join(nativeOs.tmpdir(), 'ssh-helper-test-home');

function mockSshKey(relPath: string): string {
  const keyPath = nativePath.join(FAKE_HOME, relPath);
  mockExistingFiles.add(keyPath.replace(/\\/g, '/'));
  return keyPath;
}

beforeAll(() => {
  fakeHomeOverride = FAKE_HOME;
});

afterAll(() => {
  fakeHomeOverride = undefined;
});

beforeEach(() => {
  mockExistingFiles = new Set();
  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_TOKEN;
  delete process.env.FACTIII_ON_SERVER;
});

describe('findSshKeyForStage', () => {
  test('finds staging_deploy_key for staging stage under ~/.ssh/factiii/<project>/', () => {
    const keyPath = mockSshKey(nativePath.join('.ssh', 'factiii', 'myapp', 'staging_deploy_key'));
    expect(findSshKeyForStage('staging', 'myapp')).toBe(keyPath);
  });

  test('finds prod_deploy_key for prod stage under ~/.ssh/factiii/<project>/', () => {
    const keyPath = mockSshKey(nativePath.join('.ssh', 'factiii', 'myapp', 'prod_deploy_key'));
    expect(findSshKeyForStage('prod', 'myapp')).toBe(keyPath);
  });

  test('finds mac_deploy_key for mac stage under ~/.ssh/factiii/<project>/', () => {
    const keyPath = mockSshKey(nativePath.join('.ssh', 'factiii', 'myapp', 'mac_deploy_key'));
    expect(findSshKeyForStage('mac', 'myapp')).toBe(keyPath);
  });

  test('returns null when key does not exist', () => {
    expect(findSshKeyForStage('staging', 'myapp')).toBeNull();
  });

  test('returns null when key at old legacy path (~/.ssh/staging_deploy_key) but not new path', () => {
    // Old location — should not be found under new scheme
    mockSshKey(nativePath.join('.ssh', 'staging_deploy_key'));
    expect(findSshKeyForStage('staging', 'myapp')).toBeNull();
  });

  test('isolates by project name — key for other project is not returned', () => {
    mockSshKey(nativePath.join('.ssh', 'factiii', 'otherapp', 'staging_deploy_key'));
    expect(findSshKeyForStage('staging', 'myapp')).toBeNull();
  });
});

describe('findProdPemKey', () => {
  test('finds prod.pem at ~/.ssh/factiii/<project>/prod.pem when no override configured', () => {
    const pemPath = mockSshKey(nativePath.join('.ssh', 'factiii', 'myapp', 'prod.pem'));
    const config: FactiiiConfig = { name: 'myapp' } as FactiiiConfig;
    expect(findProdPemKey(config)).toBe(pemPath);
  });

  test('returns null when prod.pem does not exist', () => {
    const config: FactiiiConfig = { name: 'myapp' } as FactiiiConfig;
    expect(findProdPemKey(config)).toBeNull();
  });

  test('uses configured aws.prod_ssh_key_path when set', () => {
    const customPath = nativePath.join(FAKE_HOME, '.ssh', 'custom-key.pem');
    mockExistingFiles.add(customPath.replace(/\\/g, '/'));
    const config: FactiiiConfig = {
      name: 'myapp',
      aws: { prod_ssh_key_path: customPath } as any,
    } as FactiiiConfig;
    expect(findProdPemKey(config)).toBe(customPath);
  });

  test('expands ~ in configured aws.prod_ssh_key_path', () => {
    const expandedPath = nativePath.join(FAKE_HOME, '.ssh', 'custom-key.pem');
    mockExistingFiles.add(expandedPath.replace(/\\/g, '/'));
    const config: FactiiiConfig = {
      name: 'myapp',
      aws: { prod_ssh_key_path: '~/.ssh/custom-key.pem' } as any,
    } as FactiiiConfig;
    expect(findProdPemKey(config)).toBe(expandedPath);
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
