import * as os from 'os';
import * as path from 'path';
import { getStackSshDir, getStackSshKeyPath } from '../src/utils/ssh-paths';

describe('getStackSshDir', () => {
  test('returns ~/.ssh/factiii/<project>', () => {
    expect(getStackSshDir('myapp')).toBe(path.join(os.homedir(), '.ssh', 'factiii', 'myapp'));
  });

  test('throws on empty project name', () => {
    expect(() => getStackSshDir('')).toThrow();
  });
});

describe('getStackSshKeyPath', () => {
  test('returns ~/.ssh/factiii/<project>/<stage>_deploy_key', () => {
    expect(getStackSshKeyPath('myapp', 'staging')).toBe(
      path.join(os.homedir(), '.ssh', 'factiii', 'myapp', 'staging_deploy_key')
    );
  });
});
