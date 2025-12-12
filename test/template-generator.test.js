const {
  generateEnvTemplate,
  createEnvTemplates,
  generateSecretsChecklist
} = require('../src/utils/template-generator');
const fs = require('fs');
const path = require('path');

describe('Template Generator', () => {
  describe('generateEnvTemplate', () => {
    it('should generate staging template from dev env', () => {
      const devEnv = { 
        NODE_ENV: 'development',
        DATABASE_URL: 'EXAMPLE-url',
        JWT_SECRET: 'EXAMPLE-secret'
      };
      const template = generateEnvTemplate('staging', devEnv);
      
      expect(template).toContain('.env.staging');
      expect(template).toContain('NODE_ENV=');
      expect(template).toContain('DATABASE_URL=');
      expect(template).toContain('JWT_SECRET=');
      // EXAMPLE values are replaced with <FILL_IN>
      expect(template).toContain('<FILL_IN');
    });

    it('should generate prod template from dev env', () => {
      const devEnv = { 
        NODE_ENV: 'development',
        DATABASE_URL: 'EXAMPLE-url',
        API_KEY: 'EXAMPLE-key'
      };
      const template = generateEnvTemplate('prod', devEnv);
      
      expect(template).toContain('.env.prod');
      expect(template).toContain('ALWAYS be in .gitignore');
      expect(template).toContain('<FILL_IN');
    });

    it('should include instructions', () => {
      const devEnv = { KEY1: 'value1' };
      const template = generateEnvTemplate('staging', devEnv);
      
      expect(template).toContain('Instructions:');
      expect(template).toContain('npx core init');
    });
  });

  describe('generateSecretsChecklist', () => {
    it('should return checklist with all required secrets', () => {
      const checklist = generateSecretsChecklist();
      
      expect(checklist).toContain('STAGING_SSH');
      expect(checklist).toContain('PROD_SSH');
      expect(checklist).toContain('AWS_ACCESS_KEY_ID');
      expect(checklist).toContain('STAGING_ENVS');
      expect(checklist).toContain('PROD_ENVS');
      expect(checklist).toContain('How to add secrets:');
    });
  });

  describe('createEnvTemplates', () => {
    const testDir = path.join(__dirname, '.temp-test');

    beforeEach(() => {
      // Create test directory
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }
    });

    afterEach(() => {
      // Cleanup test directory
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should create env templates when they don\'t exist', () => {
      const config = { name: 'test-app' };
      const result = createEnvTemplates(testDir, config);
      
      expect(result.created).toContain('.env.staging');
      expect(result.created).toContain('.env.prod');
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
      
      // Verify files were created
      expect(fs.existsSync(path.join(testDir, '.env.staging'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, '.env.prod'))).toBe(true);
    });

    it('should skip existing files', () => {
      const config = { name: 'test-app' };
      
      // Create file first
      fs.writeFileSync(path.join(testDir, '.env.staging'), 'existing content');
      
      const result = createEnvTemplates(testDir, config);
      
      expect(result.skipped).toContain('.env.staging');
      expect(result.created).toContain('.env.prod');
      
      // Verify existing file wasn't overwritten
      const content = fs.readFileSync(path.join(testDir, '.env.staging'), 'utf8');
      expect(content).toBe('existing content');
    });
  });
});

