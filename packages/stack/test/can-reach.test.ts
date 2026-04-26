/**
 * Tests for canReach() - the routing decision maker
 *
 * Dev-direct model:
 * - dev: always local
 * - staging/prod: `local` when a real domain (non-EXAMPLE) or AWS config exists;
 *   the CLI runs on dev, reaches the server through the per-stage SSH tunnel
 *   (opened by the `ssh-tunnel-<stage>` scanfix lazily). No `via: 'ssh'` or
 *   `'workflow'` branches — the dev machine is the only agent.
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

jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
  spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

import FactiiiPipeline from '../src/plugins/pipelines/factiii/index';
import AWSPipeline from '../src/plugins/pipelines/aws/index';
import type { FactiiiConfig, Stage } from '../src/types/index';

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

describe('canReach - staging/prod stages', () => {
  test('staging with a real domain is reachable locally', () => {
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) expect(result.via).toBe('local');
  });

  test('prod (labelled "production") with a real domain is reachable locally', () => {
    const result = FactiiiPipeline.canReach('prod', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) expect(result.via).toBe('local');
  });

  test('SSH key presence does not change routing — still local', () => {
    mockSshKey('staging_deploy_key');
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) expect(result.via).toBe('local');
  });

  test('GITHUB_TOKEN does not change routing — still local', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    const result = FactiiiPipeline.canReach('staging', baseConfig);
    expect(result.reachable).toBe(true);
    if (result.reachable) expect(result.via).toBe('local');
  });

  test('EXAMPLE domain with no AWS config is unreachable', () => {
    const config: FactiiiConfig = {
      name: 'test',
      staging: { server: 'ubuntu', domain: 'EXAMPLE_staging.com' },
    } as FactiiiConfig;
    const result = FactiiiPipeline.canReach('staging', config);
    expect(result.reachable).toBe(false);
    if (!result.reachable) expect(result.reason).toContain('placeholder');
  });

  test('EXAMPLE domain with AWS config is reachable (AWS can provision)', () => {
    const config: FactiiiConfig = {
      name: 'test',
      staging: {
        server: 'ubuntu',
        domain: 'EXAMPLE_staging.com',
        config: 'ec2',
        access_key_id: 'AKIAEXAMPLE',
      },
    } as FactiiiConfig;
    const result = FactiiiPipeline.canReach('staging', config);
    expect(result.reachable).toBe(true);
    if (result.reachable) expect(result.via).toBe('local');
  });
});

describe('canReach — no remote via paths', () => {
  const stages: Stage[] = ['dev', 'staging', 'prod'];

  // Minimal config covering both pipelines' branches.
  const cfg: FactiiiConfig = {
    name: 'test',
    ansible: { vault_path: 'vault.yml', vault_password_file: '~/.vault_pass' },
    staging: { domain: 'staging.test.com' },
    prod: { domain: 'prod.test.com' },
    aws: { region: 'us-east-1' },
  } as unknown as FactiiiConfig;

  for (const stage of stages) {
    test('FactiiiPipeline.canReach(' + stage + ') returns local or unreachable', () => {
      const r = FactiiiPipeline.canReach(stage, cfg);
      if (r.reachable) {
        expect(r.via).toBe('local');
      } else {
        expect(typeof r.reason).toBe('string');
      }
    });

    test('AWSPipeline.canReach(' + stage + ') returns local or unreachable', () => {
      const r = AWSPipeline.canReach(stage, cfg);
      if (r.reachable) {
        expect(r.via).toBe('local');
      } else {
        expect(typeof r.reason).toBe('string');
      }
    });
  }
});
