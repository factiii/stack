/**
 * Tests for serverExec — the single routing primitive for shell commands
 * issued by scanfixes.
 */
import * as cp from 'child_process';
import * as tunnel from '../src/utils/ssh-tunnel.js';
import { serverExec } from '../src/utils/server-exec.js';

jest.mock('child_process');
jest.mock('../src/utils/ssh-tunnel.js');

describe('serverExec', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('stage="dev" calls execSync and returns trimmed stdout', () => {
    (cp.execSync as jest.Mock).mockReturnValue(Buffer.from('  hello world\n'));
    const out = serverExec('dev', 'echo hello');
    expect(out).toBe('hello world');
    expect(cp.execSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({ encoding: 'utf8' }));
  });

  test('stage="staging" calls tunnelExec via the cached handle', () => {
    const fakeHandle = { socket: '/tmp/sock', host: 'h', user: 'u', keyPath: null, stage: 'staging' };
    (tunnel.getTunnel as jest.Mock).mockReturnValue(fakeHandle);
    (tunnel.tunnelExec as jest.Mock).mockReturnValue('docker output');
    const out = serverExec('staging', 'docker ps');
    expect(out).toBe('docker output');
    expect(tunnel.getTunnel).toHaveBeenCalledWith('staging');
    expect(tunnel.tunnelExec).toHaveBeenCalledWith(fakeHandle, 'docker ps');
  });

  test('stage="prod" calls tunnelExec via the cached handle', () => {
    const fakeHandle = { socket: '/tmp/sock', host: 'h', user: 'u', keyPath: null, stage: 'prod' };
    (tunnel.getTunnel as jest.Mock).mockReturnValue(fakeHandle);
    (tunnel.tunnelExec as jest.Mock).mockReturnValue('out');
    serverExec('prod', 'cat /etc/os-release');
    expect(tunnel.getTunnel).toHaveBeenCalledWith('prod');
  });

  test('staging with no cached tunnel throws clearly', () => {
    (tunnel.getTunnel as jest.Mock).mockReturnValue(null);
    expect(() => serverExec('staging', 'docker ps')).toThrow(
      /serverExec: no tunnel open for staging/,
    );
  });

  test('execSync non-zero exit propagates as throw', () => {
    (cp.execSync as jest.Mock).mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('Command failed: exit 1');
      throw err;
    });
    expect(() => serverExec('dev', 'false')).toThrow(/Command failed/);
  });

  test('tunnelExec error propagates as throw', () => {
    const fakeHandle = { socket: '/tmp/sock', host: 'h', user: 'u', keyPath: null, stage: 'staging' };
    (tunnel.getTunnel as jest.Mock).mockReturnValue(fakeHandle);
    (tunnel.tunnelExec as jest.Mock).mockImplementation(() => {
      throw new Error('tunnel exec failed (exit 2): nope');
    });
    expect(() => serverExec('staging', 'thing')).toThrow(/tunnel exec failed/);
  });
});
