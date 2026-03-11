/**
 * Tests for multi-repo config features:
 * - isDevOnly() helper
 * - getDefaultVaultPath() per-repo naming
 * - loadConfig() stack.local.yml merge
 * - Vercel scan logic fixes
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { isDevOnly, getDefaultVaultPath, loadConfig } from '../src/utils/config-helpers';
import type { FactiiiConfig } from '../src/types/config';

describe('isDevOnly', () => {
    test('returns true when dev_only is not set (default)', () => {
        const config = { name: 'test-repo' } as FactiiiConfig;
        expect(isDevOnly(config)).toBe(true);
    });

    test('returns true when dev_only is explicitly true', () => {
        const config = { name: 'test-repo', dev_only: true } as FactiiiConfig;
        expect(isDevOnly(config)).toBe(true);
    });

    test('returns false when dev_only is explicitly false', () => {
        const config = { name: 'test-repo', dev_only: false } as FactiiiConfig;
        expect(isDevOnly(config)).toBe(false);
    });

    test('returns true for empty config', () => {
        const config = {} as FactiiiConfig;
        expect(isDevOnly(config)).toBe(true);
    });
});

describe('getDefaultVaultPath', () => {
    test('returns per-repo vault path for named repo', () => {
        const config = { name: 'greasemoto' } as FactiiiConfig;
        expect(getDefaultVaultPath(config)).toBe('group_vars/all/vault-greasemoto.yml');
    });

    test('returns per-repo vault path for factiii', () => {
        const config = { name: 'factiii' } as FactiiiConfig;
        expect(getDefaultVaultPath(config)).toBe('group_vars/all/vault-factiii.yml');
    });

    test('falls back to vault.yml when name is missing', () => {
        const config = {} as FactiiiConfig;
        expect(getDefaultVaultPath(config)).toBe('group_vars/all/vault.yml');
    });

    test('falls back to vault.yml when name starts with EXAMPLE', () => {
        const config = { name: 'EXAMPLE_PROJECT' } as FactiiiConfig;
        expect(getDefaultVaultPath(config)).toBe('group_vars/all/vault.yml');
    });

    test('falls back for case-insensitive EXAMPLE prefix', () => {
        const config = { name: 'Example-App' } as FactiiiConfig;
        expect(getDefaultVaultPath(config)).toBe('group_vars/all/vault.yml');
    });
});

describe('loadConfig with stack.local.yml merge', () => {
    const testDir = path.join(__dirname, 'temp-config-merge-test');

    beforeEach(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('loads stack.yml without stack.local.yml', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'test-repo', dev_only: true })
        );

        const config = loadConfig(testDir);
        expect(config.name).toBe('test-repo');
        expect(config.dev_only).toBe(true);
    });

    test('stack.local.yml overrides stack.yml values', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'test-repo', dev_only: true })
        );
        fs.writeFileSync(
            path.join(testDir, 'stack.local.yml'),
            yaml.dump({ dev_only: false })
        );

        const config = loadConfig(testDir);
        expect(config.name).toBe('test-repo'); // From stack.yml
        expect(config.dev_only).toBe(false);   // Overridden by stack.local.yml
    });

    test('stack.local.yml does not exist = dev_only defaults', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'test-repo' })
        );

        const config = loadConfig(testDir);
        expect(isDevOnly(config)).toBe(true); // No dev_only = dev-only mode
    });

    test('isDevOnly returns false after stack.local override', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'test-repo', dev_only: true })
        );
        fs.writeFileSync(
            path.join(testDir, 'stack.local.yml'),
            yaml.dump({ dev_only: false })
        );

        const config = loadConfig(testDir);
        expect(isDevOnly(config)).toBe(false);
    });

    test('auto-populates ansible.vault_path from repo name when not set', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'greasemoto' })
        );

        const config = loadConfig(testDir);
        expect(config.ansible?.vault_path).toBe('group_vars/all/vault-greasemoto.yml');
        expect(config.ansible?.vault_password_file).toBe('~/.vault_pass');
    });

    test('auto-populates vault_path even with no ansible section', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'factiii' })
        );

        const config = loadConfig(testDir);
        expect(config.ansible).toBeDefined();
        expect(config.ansible?.vault_path).toBe('group_vars/all/vault-factiii.yml');
    });

    test('explicit vault_path in stack.yml overrides auto-population', () => {
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({
                name: 'greasemoto',
                ansible: { vault_path: 'my-custom-vault.yml' }
            })
        );

        const config = loadConfig(testDir);
        expect(config.ansible?.vault_path).toBe('my-custom-vault.yml');
    });

    test('two repos get different vault paths', () => {
        // Simulate greasemoto
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'greasemoto' })
        );
        const config1 = loadConfig(testDir);

        // Simulate factiii
        fs.writeFileSync(
            path.join(testDir, 'stack.yml'),
            yaml.dump({ name: 'factiii' })
        );
        const config2 = loadConfig(testDir);

        expect(config1.ansible?.vault_path).toBe('group_vars/all/vault-greasemoto.yml');
        expect(config2.ansible?.vault_path).toBe('group_vars/all/vault-factiii.yml');
        expect(config1.ansible?.vault_path).not.toBe(config2.ansible?.vault_path);
    });
});

describe('Vercel scanfix logic', () => {
    // Import the fixes array from the Vercel scanfix config
    // We test the scan functions directly with mock configs

    test('vercel-config-missing: returns false when no vercel config', async () => {
        const { fixes } = await import('../src/plugins/addons/vercel/scanfix/config');
        const configMissing = fixes.find(f => f.id === 'vercel-config-missing');
        expect(configMissing).toBeDefined();

        const result = await configMissing!.scan({ name: 'test' } as FactiiiConfig, '/tmp');
        expect(result).toBe(false); // No vercel section = skip, not a problem
    });

    test('vercel-config-missing: returns true when vercel has EXAMPLE project name', async () => {
        const { fixes } = await import('../src/plugins/addons/vercel/scanfix/config');
        const configMissing = fixes.find(f => f.id === 'vercel-config-missing');
        expect(configMissing).toBeDefined();

        const config = {
            name: 'test',
            vercel: { project_name: 'EXAMPLE_PROJECT' },
        } as FactiiiConfig;
        const result = await configMissing!.scan(config, '/tmp');
        expect(result).toBe(true); // Example name = problem
    });

    test('vercel-config-missing: returns false when vercel is properly configured', async () => {
        const { fixes } = await import('../src/plugins/addons/vercel/scanfix/config');
        const configMissing = fixes.find(f => f.id === 'vercel-config-missing');
        expect(configMissing).toBeDefined();

        const config = {
            name: 'test',
            vercel: { project_name: 'my-real-project' },
        } as FactiiiConfig;
        const result = await configMissing!.scan(config, '/tmp');
        expect(result).toBe(false); // Properly configured = no problem
    });

    test('vercel-gitignore-missing: returns false when no vercel config', async () => {
        const { fixes } = await import('../src/plugins/addons/vercel/scanfix/config');
        const gitignoreCheck = fixes.find(f => f.id === 'vercel-gitignore-missing');
        expect(gitignoreCheck).toBeDefined();

        const result = await gitignoreCheck!.scan({ name: 'test' } as FactiiiConfig, '/tmp');
        expect(result).toBe(false); // No vercel = skip
    });
});
