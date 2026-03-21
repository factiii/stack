/**
 * Tests for the slot-based PORT system, start.sh generation,
 * and generate-all.ts slot port mapping.
 *
 * Covers:
 * - port-convention.ts scanfixes (PORT slot validation, http/https enforcement)
 * - start-sh.ts scanfix (start.sh generation and marker detection)
 * - generate-all.ts (slot-based docker compose + nginx port mapping)
 * - template-generator.ts (PORT=1 default in .env.example template)
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import type { FactiiiConfig } from '../src/types/config';

// ── Test helpers ──────────────────────────────────────────────

function createTestDir(): string {
  const dir = path.join(__dirname, 'temp-port-test-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeEnvFile(dir: string, filename: string, vars: Record<string, string>): void {
  const content = Object.entries(vars)
    .map(([k, v]) => k + '=' + v)
    .join('\n') + '\n';
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

function readEnvFile(dir: string, filename: string): Record<string, string> {
  const content = fs.readFileSync(path.join(dir, filename), 'utf8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) {
      vars[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
    }
  }
  return vars;
}

/** Config with staging + prod environments (unlocks most scanfixes) */
function makeConfig(overrides?: Partial<FactiiiConfig>): FactiiiConfig {
  return {
    name: 'test-app',
    dev_only: false,
    staging: { server: 'ubuntu', domain: 'staging.test.com' },
    prod: { server: 'ubuntu', domain: 'test.com' },
    ...overrides,
  } as FactiiiConfig;
}

// ══════════════════════════════════════════════════════════════
// PORT CONVENTION SCANFIXES
// ══════════════════════════════════════════════════════════════

describe('port-convention scanfixes', () => {
  let testDir: string;
  let fixes: any[];

  beforeAll(async () => {
    const mod = await import('../src/plugins/pipelines/factiii/scanfix/port-convention');
    fixes = mod.portConventionFixes;
  });

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    cleanTestDir(testDir);
  });

  // ── env-example-missing-port ────────────────────────────────

  describe('env-example-missing-port', () => {
    const getFix = () => fixes.find((f: any) => f.id === 'env-example-missing-port');

    test('flags when .env.example has no PORT', async () => {
      writeEnvFile(testDir, '.env.example', { NODE_ENV: 'development', API_URL: 'http://localhost:5001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(true);
    });

    test('passes when .env.example has PORT', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '1', NODE_ENV: 'development' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('skips when no .env.example exists', async () => {
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('skips when no environments configured', async () => {
      writeEnvFile(testDir, '.env.example', { NODE_ENV: 'development' });
      const result = await getFix().scan({ name: 'test' } as FactiiiConfig, testDir);
      expect(result).toBe(false);
    });
  });

  // ── env-example-port-not-slot ───────────────────────────────

  describe('env-example-port-not-slot', () => {
    const getFix = () => fixes.find((f: any) => f.id === 'env-example-port-not-slot');

    test('flags PORT=3001 (full port, not slot)', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '3001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(true);
    });

    test('flags PORT=5002 (server port, not slot)', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '5002' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(true);
    });

    test('passes PORT=1 (valid slot)', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '1' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('passes PORT=5 (valid slot)', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '5' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('auto-fixes PORT=3001 → PORT=1', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '3001', NODE_ENV: 'development' });
      const fixed = await getFix().fix(makeConfig(), testDir);
      expect(fixed).toBe(true);

      const vars = readEnvFile(testDir, '.env.example');
      expect(vars.PORT).toBe('1');
    });

    test('auto-fixes PORT=5003 → PORT=3', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '5003' });
      const fixed = await getFix().fix(makeConfig(), testDir);
      expect(fixed).toBe(true);

      const vars = readEnvFile(testDir, '.env.example');
      expect(vars.PORT).toBe('3');
    });

    test('cannot auto-fix PORT=8080 (unknown pattern)', async () => {
      writeEnvFile(testDir, '.env.example', { PORT: '8080' });
      const fixed = await getFix().fix(makeConfig(), testDir);
      expect(fixed).toBe(false); // No auto-conversion possible
    });
  });

  // ── dev-env-https-urls ──────────────────────────────────────

  describe('dev-env-https-urls', () => {
    const getFix = () => fixes.find((f: any) => f.id === 'dev-env-https-urls');

    test('flags https:// in .env.example URL vars', async () => {
      writeEnvFile(testDir, '.env.example', { API_URL: 'https://localhost:5001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(true);
    });

    test('passes http:// in .env.example', async () => {
      writeEnvFile(testDir, '.env.example', { API_URL: 'http://localhost:5001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('ignores non-URL keys with https', async () => {
      writeEnvFile(testDir, '.env.example', { JWT_SECRET: 'https://not-a-url-key' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('auto-fixes https → http in URL vars', async () => {
      writeEnvFile(testDir, '.env.example', {
        API_URL: 'https://localhost:5001',
        FRONTEND_URL: 'https://localhost:3001',
      });
      const fixed = await getFix().fix(makeConfig(), testDir);
      expect(fixed).toBe(true);

      const vars = readEnvFile(testDir, '.env.example');
      expect(vars.API_URL).toBe('http://localhost:5001');
      expect(vars.FRONTEND_URL).toBe('http://localhost:3001');
    });
  });

  // ── staging-env-http-urls ───────────────────────────────────

  describe('staging-env-http-urls', () => {
    const getFix = () => fixes.find((f: any) => f.id === 'staging-env-http-urls');

    test('flags http:// in .env.staging (non-localhost)', async () => {
      writeEnvFile(testDir, '.env.staging', { API_URL: 'http://staging.example.com:5001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(true);
    });

    test('passes https:// in .env.staging', async () => {
      writeEnvFile(testDir, '.env.staging', { API_URL: 'https://staging.example.com' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('ignores http://localhost in .env.staging', async () => {
      writeEnvFile(testDir, '.env.staging', { API_URL: 'http://localhost:5001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('skips when no staging environment configured', async () => {
      writeEnvFile(testDir, '.env.staging', { API_URL: 'http://example.com' });
      const config = { name: 'test', prod: { server: 'ubuntu', domain: 'test.com' } } as FactiiiConfig;
      const result = await getFix().scan(config, testDir);
      expect(result).toBe(false);
    });

    test('auto-fixes http → https in .env.staging', async () => {
      writeEnvFile(testDir, '.env.staging', { API_URL: 'http://staging.example.com:5001' });
      const fixed = await getFix().fix(makeConfig(), testDir);
      expect(fixed).toBe(true);

      const vars = readEnvFile(testDir, '.env.staging');
      expect(vars.API_URL).toBe('https://staging.example.com:5001');
    });
  });

  // ── prod-env-http-urls ──────────────────────────────────────

  describe('prod-env-http-urls', () => {
    const getFix = () => fixes.find((f: any) => f.id === 'prod-env-http-urls');

    test('flags http:// in .env.prod (non-localhost)', async () => {
      writeEnvFile(testDir, '.env.prod', { API_URL: 'http://example.com/api' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(true);
    });

    test('passes https:// in .env.prod', async () => {
      writeEnvFile(testDir, '.env.prod', { API_URL: 'https://example.com/api' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('ignores http://127.0.0.1 in .env.prod', async () => {
      writeEnvFile(testDir, '.env.prod', { API_URL: 'http://127.0.0.1:5001' });
      const result = await getFix().scan(makeConfig(), testDir);
      expect(result).toBe(false);
    });

    test('auto-fixes http → https in .env.prod', async () => {
      writeEnvFile(testDir, '.env.prod', {
        API_URL: 'http://example.com/api',
        NEXT_PUBLIC_API_URL: 'http://example.com/api',
      });
      const fixed = await getFix().fix(makeConfig(), testDir);
      expect(fixed).toBe(true);

      const vars = readEnvFile(testDir, '.env.prod');
      expect(vars.API_URL).toBe('https://example.com/api');
      expect(vars.NEXT_PUBLIC_API_URL).toBe('https://example.com/api');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// START.SH SCANFIX
// ══════════════════════════════════════════════════════════════

describe('start-sh scanfix', () => {
  let testDir: string;
  let fixes: any[];

  beforeAll(async () => {
    const mod = await import('../src/plugins/pipelines/factiii/scanfix/start-sh');
    fixes = mod.startShFixes;
  });

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    cleanTestDir(testDir);
  });

  const getFix = () => fixes.find((f: any) => f.id === 'missing-start-sh');

  test('flags when start.sh does not exist and compose exists', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');
    const result = await getFix().scan(makeConfig(), testDir);
    expect(result).toBe(true);
  });

  test('flags when start.sh exists but missing slot markers', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');
    fs.writeFileSync(path.join(testDir, 'start.sh'), '#!/bin/bash\nset -e\ndocker compose up\n');
    const result = await getFix().scan(makeConfig(), testDir);
    expect(result).toBe(true);
  });

  test('passes when start.sh has slot markers with current version', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');
    // Import to get the actual version
    const { getFactiiiVersion } = await import('../src/utils/version-check');
    const version = getFactiiiVersion();
    fs.writeFileSync(
      path.join(testDir, 'start.sh'),
      '#!/bin/bash\nset -e\n# ── @factiii/stack slot setup BEGIN ──\n# Generated by @factiii/stack v' + version + '\nstuff\n# ── @factiii/stack slot setup END ──\n'
    );
    const result = await getFix().scan(makeConfig(), testDir);
    expect(result).toBe(false);
  });

  test('skips when no docker compose file exists', async () => {
    const result = await getFix().scan(makeConfig(), testDir);
    expect(result).toBe(false);
  });

  // ── No start.sh: generates full version ─────────────────────

  test('generates full start.sh when none exists', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');
    const fixed = await getFix().fix(makeConfig(), testDir);
    expect(fixed).toBe(true);

    const content = fs.readFileSync(path.join(testDir, 'start.sh'), 'utf8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('Generated by @factiii/stack');
    expect(content).toContain('detect_ip');
    expect(content).toContain('stack.yml');
    expect(content).toContain('PORT');
    expect(content).toContain('pnpm install');
    expect(content).toContain('docker compose');
    expect(content).toContain('init.sql');
    expect(content).toContain('3000 + SLOT');
    expect(content).toContain('5000 + SLOT');
    // Has both markers
    expect(content).toContain('slot setup BEGIN');
    expect(content).toContain('slot setup END');
  });

  // ── Existing start.sh: merges slot section ──────────────────

  test('merges slot section into existing start.sh without destroying it', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');
    // Write a custom start.sh (like the factiii app has)
    const customStartSh =
      '#!/usr/bin/env bash\n' +
      'set -e\n' +
      '\n' +
      '# Custom app logic\n' +
      'echo "Starting my app"\n' +
      'docker compose up -d\n' +
      'wait_for_postgres "Dev" "Dev"\n' +
      'run_migrations\n';
    fs.writeFileSync(path.join(testDir, 'start.sh'), customStartSh, 'utf8');

    const fixed = await getFix().fix(makeConfig(), testDir);
    expect(fixed).toBe(true);

    const content = fs.readFileSync(path.join(testDir, 'start.sh'), 'utf8');

    // Slot section injected
    expect(content).toContain('slot setup BEGIN');
    expect(content).toContain('detect_ip');
    expect(content).toContain('SYSTEM_IP');
    expect(content).toContain('slot setup END');

    // Original code preserved BELOW the markers
    expect(content).toContain('echo "Starting my app"');
    expect(content).toContain('docker compose up -d');
    expect(content).toContain('wait_for_postgres');
    expect(content).toContain('run_migrations');
  });

  test('re-running updates slot section without duplicating', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');

    const customStartSh =
      '#!/usr/bin/env bash\n' +
      'set -e\n' +
      '\n' +
      'echo "my app logic"\n';
    fs.writeFileSync(path.join(testDir, 'start.sh'), customStartSh, 'utf8');

    // First merge
    await getFix().fix(makeConfig(), testDir);
    const after1 = fs.readFileSync(path.join(testDir, 'start.sh'), 'utf8');
    const beginCount1 = (after1.match(/slot setup BEGIN/g) || []).length;
    expect(beginCount1).toBe(1);

    // Second merge (idempotent)
    await getFix().fix(makeConfig(), testDir);
    const after2 = fs.readFileSync(path.join(testDir, 'start.sh'), 'utf8');
    const beginCount2 = (after2.match(/slot setup BEGIN/g) || []).length;
    expect(beginCount2).toBe(1); // Still only one section

    // Original code still there
    expect(after2).toContain('echo "my app logic"');
  });

  test('slot section appears before custom code', async () => {
    fs.writeFileSync(path.join(testDir, 'docker-compose.yml'), 'version: "3"\n');
    fs.writeFileSync(
      path.join(testDir, 'start.sh'),
      '#!/bin/bash\nset -e\n\necho "custom logic"\ndocker compose up\n',
      'utf8'
    );

    await getFix().fix(makeConfig(), testDir);
    const content = fs.readFileSync(path.join(testDir, 'start.sh'), 'utf8');

    const beginIdx = content.indexOf('slot setup BEGIN');
    const endIdx = content.indexOf('slot setup END');
    const customIdx = content.indexOf('echo "custom logic"');

    // Markers should come before custom code
    expect(beginIdx).toBeLessThan(customIdx);
    expect(endIdx).toBeLessThan(customIdx);
  });

  test('detects compose.yml variant in full generation', async () => {
    fs.writeFileSync(path.join(testDir, 'compose.yml'), 'version: "3"\n');
    const fixed = await getFix().fix(makeConfig(), testDir);
    expect(fixed).toBe(true);

    const content = fs.readFileSync(path.join(testDir, 'start.sh'), 'utf8');
    expect(content).toContain('compose.yml');
  });
});

// ══════════════════════════════════════════════════════════════
// GENERATE-ALL.TS SLOT PORT MAPPING
// ══════════════════════════════════════════════════════════════

describe('generate-all.ts slot port mapping', () => {
  let testDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    testDir = createTestDir();
    // Point FACTIII_DIR to our test dir so generate-all writes there
    originalEnv = process.env.FACTIII_DIR;
    process.env.FACTIII_DIR = testDir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.FACTIII_DIR = originalEnv;
    } else {
      delete process.env.FACTIII_DIR;
    }
    cleanTestDir(testDir);
  });

  test('slot port=2 generates 3002:3002 and 5002:5002 in docker-compose', async () => {
    const { generateDockerCompose } = await import('../src/scripts/generate-all');

    const configs = {
      'myapp': {
        name: 'myapp',
        staging: {
          server: 'ubuntu',
          domain: 'staging.myapp.com',
          port: 2,  // Slot 2
        },
      } as FactiiiConfig,
    };

    generateDockerCompose(configs);

    const composePath = path.join(testDir, 'docker-compose.yml');
    expect(fs.existsSync(composePath)).toBe(true);

    const compose = yaml.load(fs.readFileSync(composePath, 'utf8')) as any;
    const service = compose.services['myapp-staging'];
    expect(service).toBeDefined();
    expect(service.ports).toContain('3002:3002');
    expect(service.ports).toContain('5002:5002');
  });

  test('slot port=1 generates 3001:3001 and 5001:5001', async () => {
    const { generateDockerCompose } = await import('../src/scripts/generate-all');

    const configs = {
      'app1': {
        name: 'app1',
        prod: {
          server: 'ubuntu',
          domain: 'app1.com',
          port: 1,
        },
      } as FactiiiConfig,
    };

    generateDockerCompose(configs);

    const compose = yaml.load(
      fs.readFileSync(path.join(testDir, 'docker-compose.yml'), 'utf8')
    ) as any;
    const service = compose.services['app1-prod'];
    expect(service.ports).toContain('3001:3001');
    expect(service.ports).toContain('5001:5001');
  });

  test('legacy port=8080 keeps as-is (backwards compat)', async () => {
    const { generateDockerCompose } = await import('../src/scripts/generate-all');

    const configs = {
      'legacy': {
        name: 'legacy',
        staging: {
          server: 'ubuntu',
          domain: 'legacy.com',
          port: 8080,
        },
      } as FactiiiConfig,
    };

    generateDockerCompose(configs);

    const compose = yaml.load(
      fs.readFileSync(path.join(testDir, 'docker-compose.yml'), 'utf8')
    ) as any;
    const service = compose.services['legacy-staging'];
    expect(service.ports).toContain('8080:8080');
    expect(service.ports).not.toContain('3080:3080'); // Should NOT slot-convert
  });

  test('no port defaults to expose 3000', async () => {
    const { generateDockerCompose } = await import('../src/scripts/generate-all');

    const configs = {
      'noport': {
        name: 'noport',
        staging: {
          server: 'ubuntu',
          domain: 'noport.com',
        },
      } as FactiiiConfig,
    };

    generateDockerCompose(configs);

    const compose = yaml.load(
      fs.readFileSync(path.join(testDir, 'docker-compose.yml'), 'utf8')
    ) as any;
    const service = compose.services['noport-staging'];
    expect(service.expose).toContain('3000');
    expect(service.ports).toBeUndefined();
  });

  test('nginx uses slot-derived client port (300N) for proxy_pass', async () => {
    const { generateNginx } = await import('../src/scripts/generate-all');

    const configs = {
      'webapp': {
        name: 'webapp',
        staging: {
          server: 'ubuntu',
          domain: 'staging.webapp.com',
          port: 3,  // Slot 3 → nginx should proxy to 3003
        },
      } as FactiiiConfig,
    };

    generateNginx(configs);

    const nginxPath = path.join(testDir, 'nginx.conf');
    expect(fs.existsSync(nginxPath)).toBe(true);

    const content = fs.readFileSync(nginxPath, 'utf8');
    expect(content).toContain('proxy_pass http://webapp-staging:3003');
    expect(content).toContain('server_name staging.webapp.com');
  });

  test('multi-repo slots produce separate ports', async () => {
    const { generateDockerCompose } = await import('../src/scripts/generate-all');

    const configs = {
      'app-a': {
        name: 'app-a',
        staging: { server: 'ubuntu', domain: 'a.test.com', port: 1 },
      } as FactiiiConfig,
      'app-b': {
        name: 'app-b',
        staging: { server: 'ubuntu', domain: 'b.test.com', port: 2 },
      } as FactiiiConfig,
    };

    generateDockerCompose(configs);

    const compose = yaml.load(
      fs.readFileSync(path.join(testDir, 'docker-compose.yml'), 'utf8')
    ) as any;

    expect(compose.services['app-a-staging'].ports).toContain('3001:3001');
    expect(compose.services['app-a-staging'].ports).toContain('5001:5001');
    expect(compose.services['app-b-staging'].ports).toContain('3002:3002');
    expect(compose.services['app-b-staging'].ports).toContain('5002:5002');
  });
});

// ══════════════════════════════════════════════════════════════
// TEMPLATE GENERATOR
// ══════════════════════════════════════════════════════════════

describe('template-generator PORT default', () => {
  test('generates PORT=1 (slot) not PORT=3000', async () => {
    const { generateEnvExampleTemplate } = await import('../src/utils/template-generator');
    const template = generateEnvExampleTemplate({ name: 'test-app' } as FactiiiConfig);

    // Should have slot-based PORT
    expect(template).toContain('PORT=1');
    expect(template).not.toContain('PORT=3000');

    // Should have slot explanation comment
    expect(template).toMatch(/[Ss]lot/);
    expect(template).toMatch(/3000\+PORT|3000 \+ PORT|Client.*3000/i);
  });

  test('URL placeholders use YOUR_IP', async () => {
    const { generateEnvExampleTemplate } = await import('../src/utils/template-generator');
    const template = generateEnvExampleTemplate({ name: 'test-app' } as FactiiiConfig);

    expect(template).toContain('YOUR_IP');
  });
});

// ══════════════════════════════════════════════════════════════
// INTEGRATION: FIXES REGISTERED IN PIPELINE
// ══════════════════════════════════════════════════════════════

describe('fixes registered in factiii pipeline', () => {
  test('portConventionFixes are in the pipeline fixes array', async () => {
    const { default: FactiiiPipeline } = await import('../src/plugins/pipelines/factiii/index');
    const pipeline = FactiiiPipeline as any;
    const fixIds = pipeline.fixes.map((f: any) => f.id);

    expect(fixIds).toContain('env-example-missing-port');
    expect(fixIds).toContain('env-example-port-not-slot');
    expect(fixIds).toContain('dev-env-https-urls');
    expect(fixIds).toContain('staging-env-http-urls');
    expect(fixIds).toContain('prod-env-http-urls');
  });

  test('startShFixes are in the pipeline fixes array', async () => {
    const { default: FactiiiPipeline } = await import('../src/plugins/pipelines/factiii/index');
    const pipeline = FactiiiPipeline as any;
    const fixIds = pipeline.fixes.map((f: any) => f.id);

    expect(fixIds).toContain('missing-start-sh');
  });

  test('old missing-start-sh from workflows is replaced (not duplicated)', async () => {
    const { default: FactiiiPipeline } = await import('../src/plugins/pipelines/factiii/index');
    const pipeline = FactiiiPipeline as any;
    const startShFixes = pipeline.fixes.filter((f: any) => f.id === 'missing-start-sh');

    // Should only appear once (from start-sh.ts, not workflows.ts)
    expect(startShFixes.length).toBe(1);
  });
});
