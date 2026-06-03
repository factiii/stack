import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vaultPasswordFileLocationFix } from '../src/plugins/pipelines/factiii/scanfix/migrations/vault-password-file-location';
import type { FactiiiConfig } from '../src/types/config';

describe('vault-password-file-location migration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-vault-mig-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('scan returns false when <repo>/.vault_pass already exists', async () => {
    fs.writeFileSync(path.join(tmpDir, '.vault_pass'), 'pwd');
    const config = {
      name: 'test',
      ansible: { vault_path: 'vault.yml', vault_password_file: '.vault_pass' },
    } as FactiiiConfig;
    const trigger = await vaultPasswordFileLocationFix.scan(config, tmpDir);
    expect(trigger).toBe(false);
  });

  test('scan returns true when config points at ~/.vault_pass', async () => {
    const config = {
      name: 'test',
      ansible: { vault_path: 'vault.yml', vault_password_file: '~/.vault_pass' },
    } as FactiiiConfig;
    const trigger = await vaultPasswordFileLocationFix.scan(config, tmpDir);
    expect(trigger).toBe(true);
  });

  test('fix writes <repo>/.vault_pass with mode 0600 and updates stack.yml', async () => {
    // Put the legacy password file in a sibling tmpdir (outside the repo) so the
    // test doesn't touch the developer's real ~/.vault_pass.
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-vault-src-'));
    const externalPath = path.join(externalDir, '.vault_pass');
    fs.writeFileSync(externalPath, 'home-password\n', { mode: 0o600 });

    try {
      fs.writeFileSync(
        path.join(tmpDir, 'stack.yml'),
        'name: test\nansible:\n  vault_path: vault.yml\n  vault_password_file: ' + externalPath + '\n'
      );

      const config = {
        name: 'test',
        ansible: { vault_path: 'vault.yml', vault_password_file: externalPath },
      } as FactiiiConfig;

      const result = await vaultPasswordFileLocationFix.fix!(config, tmpDir);
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.vault_pass'))).toBe(true);
      if (process.platform !== 'win32') {
        const stat = fs.statSync(path.join(tmpDir, '.vault_pass'));
        expect(stat.mode & 0o777).toBe(0o600);
      }

      const stackYml = fs.readFileSync(path.join(tmpDir, 'stack.yml'), 'utf8');
      expect(stackYml).toContain('vault_password_file: .vault_pass');

      const gitignore = fs.existsSync(path.join(tmpDir, '.gitignore'))
        ? fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')
        : '';
      expect(gitignore).toMatch(/^\.vault_pass$/m);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
