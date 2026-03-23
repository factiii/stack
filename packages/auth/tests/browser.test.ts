import { describe, it, expect } from 'vitest';
import { detectBrowser, isMobileDevice, isNativeApp } from '../src/utilities/browser';

describe('detectBrowser', () => {
  it('detects Chrome', () => {
    expect(detectBrowser('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36')).toBe(
      'Chrome'
    );
  });

  it('detects Firefox', () => {
    expect(detectBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0')).toBe(
      'Firefox'
    );
  });

  it('detects Safari', () => {
    expect(
      detectBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')
    ).toBe('Safari');
  });

  it('detects iOS Safari', () => {
    expect(
      detectBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    ).toBe('iOS Browser (Safari)');
  });

  it('detects iOS App', () => {
    expect(detectBrowser('MyApp/1.0 CFNetwork/1490.0.4 Darwin/23.0.0')).toBe('iOS App');
  });

  it('detects Android Chrome', () => {
    expect(
      detectBrowser('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36')
    ).toBe('Android Browser (Chrome)');
  });

  it('returns Unknown for empty string', () => {
    expect(detectBrowser('')).toBe('Unknown');
  });

  it('returns Unknown for random string', () => {
    expect(detectBrowser('some-random-agent')).toBe('Unknown');
  });
});

describe('isMobileDevice', () => {
  it('returns true for iPhone', () => {
    expect(isMobileDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
  });

  it('returns true for Android', () => {
    expect(isMobileDevice('Mozilla/5.0 (Linux; Android 14)')).toBe(true);
  });

  it('returns false for desktop Chrome', () => {
    expect(isMobileDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0')).toBe(false);
  });
});

describe('isNativeApp', () => {
  it('returns true for iOS app', () => {
    expect(isNativeApp('CFNetwork/1490.0.4 Darwin/23.0.0')).toBe(true);
  });

  it('returns false for browser', () => {
    expect(isNativeApp('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0')).toBe(false);
  });
});
