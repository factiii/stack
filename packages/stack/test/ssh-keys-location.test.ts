import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sshKeysLocationFix } from '../src/plugins/pipelines/factiii/scanfix/migrations/ssh-keys-location';
import type { FactiiiConfig } from '../src/types/config';

describe('ssh-keys-location migration', () => {
  let homeBackup: string;
  let tmpHome: string;

  beforeEach(() => {
    homeBackup = os.homedir();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-ssh-mig-'));
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    process.env.HOME = homeBackup;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function pk() { return '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n'; }

  test('scan returns false when factiii/<project>/ already exists', async () => {
    fs.mkdirSync(path.join(tmpHome, '.ssh', 'factiii', 'foo'), { recursive: true });
    const config = { name: 'foo' } as FactiiiConfig;
    expect(await sshKeysLocationFix.scan(config, tmpHome)).toBe(false);
  });

  test('scan returns true when a legacy key exists', async () => {
    fs.writeFileSync(path.join(tmpHome, '.ssh', 'staging_deploy_key'), pk());
    const config = { name: 'foo' } as FactiiiConfig;
    expect(await sshKeysLocationFix.scan(config, tmpHome)).toBe(true);
  });

  test('fix moves suffixed key, copies unsuffixed key', async () => {
    fs.writeFileSync(path.join(tmpHome, '.ssh', 'staging_deploy_key_foo'), pk());
    fs.writeFileSync(path.join(tmpHome, '.ssh', 'prod_deploy_key'), pk());

    const config = { name: 'foo' } as FactiiiConfig;
    const result = await sshKeysLocationFix.fix!(config, tmpHome);
    expect(result).toBe(true);

    expect(fs.existsSync(path.join(tmpHome, '.ssh', 'factiii', 'foo', 'staging_deploy_key'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.ssh', 'staging_deploy_key_foo'))).toBe(false); // moved
    expect(fs.existsSync(path.join(tmpHome, '.ssh', 'factiii', 'foo', 'prod_deploy_key'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.ssh', 'prod_deploy_key'))).toBe(true); // copied, not moved
  });
});
