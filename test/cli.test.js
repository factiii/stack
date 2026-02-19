const fs = require('fs');
const path = require('path');
const scan = require('../src/cli/scan');
const fix = require('../src/cli/fix');
const generateWorkflows = require('../src/cli/generate-workflows');

// Legacy commands - may not exist
let validate;
try {
  validate = require('../src/cli/validate');
} catch (e) {
  // Legacy command not available
}

describe('CLI Command Tests', () => {
  const testDir = path.join(__dirname, 'temp-cli-test');
  const originalCwd = process.cwd();
  const originalExit = process.exit;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  let consoleOutput = [];
  let exitCode = null;

  beforeEach(() => {
    // Create test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    process.chdir(testDir);

    // Mock console.log and console.error
    consoleOutput = [];
    console.log = (...args) => consoleOutput.push(['log', ...args]);
    console.error = (...args) => consoleOutput.push(['error', ...args]);

    // Mock process.exit
    exitCode = null;
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    };
  });

  afterEach(() => {
    // Restore mocks
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalExit;
    process.chdir(originalCwd);

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('scan command', () => {
    test('scans and reports no issues when properly configured', async () => {
      // Create a minimal valid config
      const yaml = require('js-yaml');
      fs.writeFileSync(path.join(testDir, 'stack.yml'), yaml.dump({
        name: 'test-repo',
        environments: {
          staging: {
            domain: 'staging.test.com',
            host: '192.168.1.100'
          }
        }
      }));
      
      // Create necessary env files
      fs.writeFileSync(path.join(testDir, '.env.example'), 'DATABASE_URL=test\n');
      fs.writeFileSync(path.join(testDir, '.env'), 'DATABASE_URL=test\n');
      fs.writeFileSync(path.join(testDir, '.env.staging'), 'DATABASE_URL=test\n');
      fs.writeFileSync(path.join(testDir, '.env.prod'), 'DATABASE_URL=test\n');

      const problems = await scan({ rootDir: testDir, dev: true });

      expect(problems).toHaveProperty('dev');
      expect(Array.isArray(problems.dev)).toBe(true);
    });

    test('detects missing stack.yml', async () => {
      const problems = await scan({ rootDir: testDir, dev: true });

      // Should detect missing config (stack.yml)
      expect(problems.dev.some(p => p.id === 'missing-stack-yml')).toBe(true);
    });

    test('returns problems grouped by stage', async () => {
      const problems = await scan({ rootDir: testDir });

      expect(problems).toHaveProperty('dev');
      expect(problems).toHaveProperty('secrets');
      expect(problems).toHaveProperty('staging');
      expect(problems).toHaveProperty('prod');
    });

    test('respects stage filters', async () => {
      const devProblems = await scan({ rootDir: testDir, dev: true });
      
      // When filtering to dev only, other stages should be empty
      expect(devProblems.secrets).toHaveLength(0);
      expect(devProblems.staging).toHaveLength(0);
      expect(devProblems.prod).toHaveLength(0);
    });
  });

  describe('fix command', () => {
    test('runs scan then applies fixes', async () => {
      // Create minimal setup
      fs.writeFileSync(path.join(testDir, '.env.example'), 'TEST=value\n');
      
      const results = await fix({ rootDir: testDir, dev: true });

      expect(results).toHaveProperty('fixed');
      expect(results).toHaveProperty('manual');
      expect(results).toHaveProperty('failed');
    });

    test('creates .env from .env.example', async () => {
      // Create .env.example but not .env
      fs.writeFileSync(path.join(testDir, '.env.example'), 'DATABASE_URL=test\n');
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ 
        dependencies: { prisma: '5.0.0' } 
      }));

      await fix({ rootDir: testDir, dev: true });

      // .env should be created from .env.example
      expect(fs.existsSync(path.join(testDir, '.env'))).toBe(true);
    });

    test('respects stage filters', async () => {
      const results = await fix({ rootDir: testDir, dev: true });

      // Should only fix dev stage issues
      expect(typeof results.fixed).toBe('number');
    });
  });

  describe('generate-workflows command', () => {
    test('generates workflow files in default directory', () => {
      const workflowsDir = path.join(testDir, '.github', 'workflows');
      const expectedFiles = [
        'stack-deploy.yml',
        'stack-undeploy.yml',
        'stack-cicd-staging.yml',
        'stack-cicd-prod.yml'
      ];

      generateWorkflows({});

      expect(fs.existsSync(workflowsDir)).toBe(true);
      expectedFiles.forEach(file => {
        const filePath = path.join(workflowsDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    });

    test('generates workflow files in custom directory', () => {
      const customDir = path.join(testDir, 'custom-workflows');
      const expectedFiles = [
        'stack-deploy.yml',
        'stack-undeploy.yml',
        'stack-cicd-staging.yml',
        'stack-cicd-prod.yml'
      ];

      generateWorkflows({ output: 'custom-workflows' });

      expect(fs.existsSync(customDir)).toBe(true);
      expectedFiles.forEach(file => {
        const filePath = path.join(customDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    });

    test('outputs success messages', () => {
      generateWorkflows({});

      expect(consoleOutput.some(o => o[1]?.includes('Generating GitHub workflows'))).toBe(true);
      expect(consoleOutput.some(o => o[1]?.includes('Workflow generation complete'))).toBe(true);
    });
  });

  // Legacy validate tests - only run if validate exists
  if (validate) {
    describe('validate command (legacy)', () => {
      test('validates a correct config file', () => {
        const configPath = path.join(testDir, 'stack.yml');
        const validConfig = {
          name: 'test-repo',
          environments: {
            staging: {
              domain: 'staging.test.com'
            }
          },
          ssl_email: 'test@example.com',
          ecr_registry: '123456789.dkr.ecr.us-east-1.amazonaws.com',
          ecr_repository: 'apps'
        };
        
        const yaml = require('js-yaml');
        fs.writeFileSync(configPath, yaml.dump(validConfig));

        validate({ config: 'stack.yml' });

        expect(consoleOutput.some(o => o[1]?.includes('Configuration is valid'))).toBe(true);
        expect(exitCode).toBeNull();
      });

      test('fails on missing name field', () => {
        const configPath = path.join(testDir, 'stack.yml');
        const invalidConfig = {
          environments: {
            staging: {
              domain: 'staging.test.com'
            }
          }
        };
        
        const yaml = require('js-yaml');
        fs.writeFileSync(configPath, yaml.dump(invalidConfig));

        try {
          validate({ config: 'stack.yml' });
          fail('Should have exited');
        } catch (error) {
          expect(exitCode).toBe(1);
          expect(consoleOutput.some(o => o[1]?.includes('Missing required field: name'))).toBe(true);
        }
      });
    });
  }
});

describe('Plugin Architecture Tests', () => {
  const testDir = path.join(__dirname, 'temp-plugin-test');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Plugin Loading', () => {
    test('loads pipeline plugins', () => {
      const { getPluginsByCategory } = require('../src/plugins');
      const pipelines = getPluginsByCategory('pipelines');
      
      expect(pipelines).toBeDefined();
      expect(pipelines['factiii']).toBeDefined();
    });

    test('loads server plugins', () => {
      const { getPluginsByCategory } = require('../src/plugins');
      const servers = getPluginsByCategory('servers');
      
      expect(servers).toBeDefined();
      expect(servers['mac-mini']).toBeDefined();
      expect(servers['aws']).toBeDefined();
    });

    test('loads framework plugins', () => {
      const { getPluginsByCategory } = require('../src/plugins');
      const frameworks = getPluginsByCategory('frameworks');
      
      expect(frameworks).toBeDefined();
      expect(frameworks['prisma-trpc']).toBeDefined();
    });
  });

  describe('Plugin Structure', () => {
    test('pipeline plugin has required static properties', () => {
      const FactiiiPipeline = require('../src/plugins/pipelines/factiii');
      
      expect(FactiiiPipeline.id).toBe('factiii');
      expect(FactiiiPipeline.category).toBe('pipeline');
      expect(Array.isArray(FactiiiPipeline.fixes)).toBe(true);
    });

    test('server plugin has required static properties', () => {
      const MacMiniPlugin = require('../src/plugins/servers/mac-mini');
      
      expect(MacMiniPlugin.id).toBe('mac-mini');
      expect(MacMiniPlugin.category).toBe('server');
      expect(Array.isArray(MacMiniPlugin.fixes)).toBe(true);
    });

    test('framework plugin has required static properties', () => {
      const PrismaTrpcPlugin = require('../src/plugins/frameworks/prisma-trpc');
      
      expect(PrismaTrpcPlugin.id).toBe('prisma-trpc');
      expect(PrismaTrpcPlugin.category).toBe('framework');
      expect(Array.isArray(PrismaTrpcPlugin.fixes)).toBe(true);
      expect(Array.isArray(PrismaTrpcPlugin.requiredEnvVars)).toBe(true);
    });
  });

  describe('Fix Structure', () => {
    test('pipeline plugin fixes have correct structure', () => {
      const FactiiiPipeline = require('../src/plugins/pipelines/factiii');
      
      for (const fix of FactiiiPipeline.fixes) {
        expect(fix.id).toBeDefined();
        expect(['dev', 'secrets', 'staging', 'prod']).toContain(fix.stage);
        expect(['critical', 'warning', 'info']).toContain(fix.severity);
        expect(fix.description).toBeDefined();
        expect(typeof fix.scan).toBe('function');
        expect(fix.manualFix).toBeDefined();
      }
    });

    test('server plugin fixes have correct structure', () => {
      const MacMiniPlugin = require('../src/plugins/servers/mac-mini');
      
      for (const fix of MacMiniPlugin.fixes) {
        expect(fix.id).toBeDefined();
        expect(['dev', 'secrets', 'staging', 'prod']).toContain(fix.stage);
        expect(['critical', 'warning', 'info']).toContain(fix.severity);
        expect(fix.description).toBeDefined();
        expect(typeof fix.scan).toBe('function');
        expect(fix.manualFix).toBeDefined();
      }
    });

    test('framework plugin fixes have correct structure', () => {
      const PrismaTrpcPlugin = require('../src/plugins/frameworks/prisma-trpc');
      
      for (const fix of PrismaTrpcPlugin.fixes) {
        expect(fix.id).toBeDefined();
        expect(['dev', 'secrets', 'staging', 'prod']).toContain(fix.stage);
        expect(['critical', 'warning', 'info']).toContain(fix.severity);
        expect(fix.description).toBeDefined();
        expect(typeof fix.scan).toBe('function');
        expect(fix.manualFix).toBeDefined();
      }
    });
  });

  describe('Plugin Instances', () => {
    test('server plugins can be instantiated and have deploy method', () => {
      const MacMiniPlugin = require('../src/plugins/servers/mac-mini');
      const instance = new MacMiniPlugin({});
      
      expect(typeof instance.deploy).toBe('function');
      expect(typeof instance.undeploy).toBe('function');
    });

    test('framework plugins can be instantiated and have deploy method', () => {
      const PrismaTrpcPlugin = require('../src/plugins/frameworks/prisma-trpc');
      const instance = new PrismaTrpcPlugin({});
      
      expect(typeof instance.deploy).toBe('function');
      expect(typeof instance.undeploy).toBe('function');
    });
  });
});
