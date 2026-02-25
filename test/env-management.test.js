const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseEnvFile,
  looksLikePlaceholder,
  isGitignored,
  compareEnvKeys,
  checkValuesNotEmpty,
  checkForPlaceholders,
  findMatchingValues,
  validateEnvFiles
} = require('../src/utils/env-validator');

const {
  generateEnvExampleTemplate,
  generateEnvTemplate,
  createEnvTemplates
} = require('../src/utils/template-generator');

describe('Environment File Management', () => {
  let testDir;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  });

  afterEach(() => {
    // Cleanup temporary directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseEnvFile', () => {
    test('should parse valid env file', () => {
      const envPath = path.join(testDir, '.env.test');
      fs.writeFileSync(envPath, 'KEY1=value1\nKEY2=value2\nKEY3=value3');
      
      const result = parseEnvFile(envPath);
      
      expect(result).toEqual({
        KEY1: 'value1',
        KEY2: 'value2',
        KEY3: 'value3'
      });
    });

    test('should ignore comments and empty lines', () => {
      const envPath = path.join(testDir, '.env.test');
      fs.writeFileSync(envPath, '# Comment\nKEY1=value1\n\nKEY2=value2\n# Another comment');
      
      const result = parseEnvFile(envPath);
      
      expect(result).toEqual({
        KEY1: 'value1',
        KEY2: 'value2'
      });
    });

    test('should return null for non-existent file', () => {
      const result = parseEnvFile(path.join(testDir, 'nonexistent.env'));
      expect(result).toBeNull();
    });

    test('should handle values with equals signs', () => {
      const envPath = path.join(testDir, '.env.test');
      fs.writeFileSync(envPath, 'DATABASE_URL=postgresql://user:pass@host:5432/db?key=value');
      
      const result = parseEnvFile(envPath);
      
      expect(result.DATABASE_URL).toBe('postgresql://user:pass@host:5432/db?key=value');
    });
  });

  describe('looksLikePlaceholder', () => {
    test('should detect EXAMPLE values', () => {
      expect(looksLikePlaceholder('EXAMPLE_value')).toBe(true);
      expect(looksLikePlaceholder('EXAMPLE.com')).toBe(true);
    });

    test('should detect <FILL values', () => {
      expect(looksLikePlaceholder('<FILL_IN>')).toBe(true);
    });

    test('should detect empty values', () => {
      expect(looksLikePlaceholder('')).toBe(true);
      expect(looksLikePlaceholder(null)).toBe(true);
    });

    test('should not flag real values', () => {
      expect(looksLikePlaceholder('actual-secret-key-123')).toBe(false);
      expect(looksLikePlaceholder('production.com')).toBe(false);
    });
  });

  describe('isGitignored', () => {
    test('should detect exact matches', () => {
      const gitignorePath = path.join(testDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '.env.prod\nnode_modules/\n');
      
      expect(isGitignored(testDir, '.env.prod')).toBe(true);
      expect(isGitignored(testDir, '.env.staging')).toBe(false);
    });

    test('should detect pattern matches', () => {
      const gitignorePath = path.join(testDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '.env.*\n');
      
      expect(isGitignored(testDir, '.env.prod')).toBe(true);
      expect(isGitignored(testDir, '.env.staging')).toBe(true);
      expect(isGitignored(testDir, '.env.example')).toBe(true);
    });

    test('should return false if .gitignore does not exist', () => {
      expect(isGitignored(testDir, '.env.prod')).toBe(false);
    });
  });

  describe('compareEnvKeys', () => {
    test('should detect matching keys', () => {
      const expected = { KEY1: 'val1', KEY2: 'val2' };
      const actual = { KEY1: 'val1', KEY2: 'val2' };
      
      const result = compareEnvKeys(expected, actual);
      
      expect(result.match).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
    });

    test('should detect missing keys', () => {
      const expected = { KEY1: 'val1', KEY2: 'val2', KEY3: 'val3' };
      const actual = { KEY1: 'val1', KEY2: 'val2' };
      
      const result = compareEnvKeys(expected, actual);
      
      expect(result.match).toBe(false);
      expect(result.missing).toEqual(['KEY3']);
    });

    test('should detect extra keys', () => {
      const expected = { KEY1: 'val1', KEY2: 'val2' };
      const actual = { KEY1: 'val1', KEY2: 'val2', KEY3: 'val3' };
      
      const result = compareEnvKeys(expected, actual);
      
      expect(result.match).toBe(false);
      expect(result.extra).toEqual(['KEY3']);
    });
  });

  describe('checkValuesNotEmpty', () => {
    test('should pass for all filled values', () => {
      const env = { KEY1: 'value1', KEY2: 'value2' };
      
      const result = checkValuesNotEmpty(env);
      
      expect(result.allFilled).toBe(true);
      expect(result.empty).toEqual([]);
    });

    test('should detect empty values', () => {
      const env = { KEY1: 'value1', KEY2: '', KEY3: '   ' };
      
      const result = checkValuesNotEmpty(env);
      
      expect(result.allFilled).toBe(false);
      expect(result.empty).toContain('KEY2');
      expect(result.empty).toContain('KEY3');
    });
  });

  describe('validateEnvFiles', () => {
    test('should error if .env.example is missing', () => {
      const result = validateEnvFiles(testDir, {});
      
      expect(result.devExists).toBe(false);
      expect(result.errors).toContain('.env.example not found (required as template)');
    });

    test('should validate complete setup', () => {
      // Create .env.example
      const devPath = path.join(testDir, '.env.example');
      fs.writeFileSync(devPath, 'KEY1=EXAMPLE\nKEY2=EXAMPLE');
      
      // Create .env.staging
      const stagingPath = path.join(testDir, '.env.staging');
      fs.writeFileSync(stagingPath, 'KEY1=staging-val1\nKEY2=staging-val2');
      
      // Create .env.prod
      const prodPath = path.join(testDir, '.env.prod');
      fs.writeFileSync(prodPath, 'KEY1=prod-val1\nKEY2=prod-val2');
      
      // Create .gitignore
      const gitignorePath = path.join(testDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '.env.prod\n');
      
      const result = validateEnvFiles(testDir, {});
      
      expect(result.devExists).toBe(true);
      expect(result.stagingExists).toBe(true);
      expect(result.prodLocal).toBe(true);
      expect(result.prodGitignored).toBe(true);
      expect(result.keysMatch).toBe(true);
      expect(result.allFilled).toBe(true);
      expect(result.errors).toEqual([]);
    });

    test('should warn about missing .env.prod if only in GitHub', () => {
      // Create .env.example
      const devPath = path.join(testDir, '.env.example');
      fs.writeFileSync(devPath, 'KEY1=EXAMPLE\nKEY2=EXAMPLE');
      
      // Create .env.staging
      const stagingPath = path.join(testDir, '.env.staging');
      fs.writeFileSync(stagingPath, 'KEY1=staging-val1\nKEY2=staging-val2');
      
      // Simulate GitHub secrets
      const githubSecrets = {
        PROD_ENVS: { KEY1: 'prod-val1', KEY2: 'prod-val2' }
      };
      
      const result = validateEnvFiles(testDir, {}, githubSecrets);
      
      expect(result.prodLocal).toBe(false);
      expect(result.prodGitHub).toBe(true);
      expect(result.prodExists).toBe(true);
      expect(result.warnings).toContain('.env.prod not local, using GitHub Secrets (OK for security)');
    });

    test('should error if keys do not match', () => {
      // Create .env.example
      const devPath = path.join(testDir, '.env.example');
      fs.writeFileSync(devPath, 'KEY1=EXAMPLE\nKEY2=EXAMPLE\nKEY3=EXAMPLE');
      
      // Create .env.staging with missing key
      const stagingPath = path.join(testDir, '.env.staging');
      fs.writeFileSync(stagingPath, 'KEY1=staging-val1\nKEY2=staging-val2');
      
      const result = validateEnvFiles(testDir, {});
      
      expect(result.keysMatch).toBe(false);
      expect(result.errors.some(e => e.includes('missing keys: KEY3'))).toBe(true);
    });
  });

  describe('generateEnvExampleTemplate', () => {
    test('should generate template with EXAMPLE values', () => {
      const template = generateEnvExampleTemplate({ name: 'testapp' });
      
      expect(template).toContain('.env.example');
      expect(template).toContain('EXAMPLE');
      expect(template).toContain('NODE_ENV=development');
      expect(template).toContain('DATABASE_URL');
    });

    test('should include repo name in examples', () => {
      const template = generateEnvExampleTemplate({ name: 'myapp' });
      
      expect(template).toContain('myapp');
    });
  });

  describe('createEnvTemplates', () => {
    test('should create all three env files', () => {
      const result = createEnvTemplates(testDir, { name: 'testapp' });
      
      expect(result.created).toContain('.env.example');
      expect(result.created).toContain('.env.staging');
      expect(result.created).toContain('.env.prod');
      expect(result.errors).toEqual([]);
      
      expect(fs.existsSync(path.join(testDir, '.env.example'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, '.env.staging'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, '.env.prod'))).toBe(true);
    });

    test('should skip existing files', () => {
      // Create .env.example first
      fs.writeFileSync(path.join(testDir, '.env.example'), 'KEY1=value1');
      
      const result = createEnvTemplates(testDir, { name: 'testapp' });
      
      expect(result.skipped).toContain('.env.example');
      expect(result.created).toContain('.env.staging');
      expect(result.created).toContain('.env.prod');
    });

    test('should use .env.example as template for staging/prod', () => {
      createEnvTemplates(testDir, { name: 'testapp' });
      
      const dev = parseEnvFile(path.join(testDir, '.env.example'));
      const staging = parseEnvFile(path.join(testDir, '.env.staging'));
      const prod = parseEnvFile(path.join(testDir, '.env.prod'));
      
      // All should have the same keys
      expect(Object.keys(staging).sort()).toEqual(Object.keys(dev).sort());
      expect(Object.keys(prod).sort()).toEqual(Object.keys(dev).sort());
    });
  });

  describe('findMatchingValues', () => {
    test('should find keys with identical values', () => {
      const env1 = { KEY1: 'same', KEY2: 'different1', KEY3: 'same' };
      const env2 = { KEY1: 'same', KEY2: 'different2', KEY3: 'same' };
      
      const result = findMatchingValues(env1, env2);
      
      expect(result).toContain('KEY1');
      expect(result).toContain('KEY3');
      expect(result).not.toContain('KEY2');
    });
  });
});

