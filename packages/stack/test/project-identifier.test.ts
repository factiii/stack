import { getStackProjectName } from '../src/utils/project-identifier';
import type { FactiiiConfig } from '../src/types/config';

describe('getStackProjectName', () => {
  test('returns config.name when set', () => {
    const config = { name: 'myapp' } as FactiiiConfig;
    expect(getStackProjectName(config)).toBe('myapp');
  });

  test('throws when name is missing', () => {
    const config = {} as FactiiiConfig;
    expect(() => getStackProjectName(config)).toThrow(/name.*stack\.yml/i);
  });

  test('throws when name is empty string', () => {
    const config = { name: '' } as FactiiiConfig;
    expect(() => getStackProjectName(config)).toThrow(/name.*stack\.yml/i);
  });

  test('throws when name has EXAMPLE_ prefix (case-insensitive)', () => {
    expect(() => getStackProjectName({ name: 'EXAMPLE_app' } as FactiiiConfig)).toThrow();
    expect(() => getStackProjectName({ name: 'example-app' } as FactiiiConfig)).toThrow();
  });
});
