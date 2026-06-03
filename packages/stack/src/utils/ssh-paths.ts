import * as os from 'os';
import * as path from 'path';

export function getStackSshDir(projectName: string): string {
  if (!projectName) throw new Error('projectName is required');
  return path.join(os.homedir(), '.ssh', 'factiii', projectName);
}

export function getStackSshKeyPath(projectName: string, stage: string): string {
  return path.join(getStackSshDir(projectName), stage + '_deploy_key');
}

export function getStackPemPath(projectName: string): string {
  return path.join(getStackSshDir(projectName), 'prod.pem');
}
