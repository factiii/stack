/**
 * Tests for the stack-version-pin dev scanfix.
 *
 * Covers the three states: missing pin, matching pin, mismatched pin.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';

import { stackVersionPinFixes } from '../src/plugins/pipelines/factiii/scanfix/stack-version-pin.js';
import type { FactiiiConfig } from '../src/types/index.js';

function makeTempProject(): { rootDir: string; config: FactiiiConfig } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-pin-'));
  const config: FactiiiConfig = {
    name: 'factiii',
    staging: { server: 'ubuntu', domain: 'staging.factiii.com' },
  };
  return { rootDir, config };
}

function readInstalledVersion(): string {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

const missingPinFix = stackVersionPinFixes.find((f) => f.id === 'stack-version-pin-missing');
const mismatchFix = stackVersionPinFixes.find((f) => f.id === 'stack-version-pin-mismatch');

describe('stack-version-pin scanfix', () => {
  let rootDir: string;
  let config: FactiiiConfig;
  const originalOnServer = process.env.FACTIII_ON_SERVER;
  const originalActions = process.env.GITHUB_ACTIONS;

  beforeEach(() => {
    delete process.env.FACTIII_ON_SERVER;
    delete process.env.GITHUB_ACTIONS;
    const p = makeTempProject();
    rootDir = p.rootDir;
    config = p.config;
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    if (originalOnServer !== undefined) process.env.FACTIII_ON_SERVER = originalOnServer;
    if (originalActions !== undefined) process.env.GITHUB_ACTIONS = originalActions;
  });

  it('both fixes are registered', () => {
    expect(missingPinFix).toBeDefined();
    expect(mismatchFix).toBeDefined();
  });

  it('missing-pin scan reports true when stackAuto.yml lacks stack_version, fix writes it', async () => {
    expect(await missingPinFix!.scan(config, rootDir)).toBe(true);
    const applied = await missingPinFix!.fix!(config, rootDir);
    expect(applied).toBe(true);

    const doc = yaml.load(fs.readFileSync(path.join(rootDir, 'stackAuto.yml'), 'utf8')) as Record<string, unknown>;
    expect(doc.stack_version).toBe(readInstalledVersion());

    // After fix, scan returns false.
    expect(await missingPinFix!.scan(config, rootDir)).toBe(false);
  });

  it('mismatch scan is false when the pin matches the installed version', async () => {
    fs.writeFileSync(
      path.join(rootDir, 'stackAuto.yml'),
      yaml.dump({ stack_version: readInstalledVersion() }),
    );
    expect(await mismatchFix!.scan(config, rootDir)).toBe(false);
    expect(await missingPinFix!.scan(config, rootDir)).toBe(false);
  });

  it('mismatch scan is true when the pin differs — and has no auto-fix', async () => {
    fs.writeFileSync(
      path.join(rootDir, 'stackAuto.yml'),
      yaml.dump({ stack_version: '99.99.99' }),
    );
    expect(await mismatchFix!.scan(config, rootDir)).toBe(true);
    expect(mismatchFix!.fix).toBeNull();
    expect(mismatchFix!.severity).toBe('critical');
  });

  it('both fixes skip when running on server (FACTIII_ON_SERVER=true)', async () => {
    process.env.FACTIII_ON_SERVER = 'true';
    expect(await missingPinFix!.scan(config, rootDir)).toBe(false);
    fs.writeFileSync(
      path.join(rootDir, 'stackAuto.yml'),
      yaml.dump({ stack_version: '99.99.99' }),
    );
    expect(await mismatchFix!.scan(config, rootDir)).toBe(false);
  });

  it('both fixes skip when the project has no environments configured', async () => {
    const bareConfig: FactiiiConfig = { name: 'lonely' };
    expect(await missingPinFix!.scan(bareConfig, rootDir)).toBe(false);
    fs.writeFileSync(
      path.join(rootDir, 'stackAuto.yml'),
      yaml.dump({ stack_version: '99.99.99' }),
    );
    expect(await mismatchFix!.scan(bareConfig, rootDir)).toBe(false);
  });
});
