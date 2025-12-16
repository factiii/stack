const {
  formatDeploymentReport,
  formatWorkflowSummary,
  generateSummary,
  formatLocalChecks
} = require('../src/utils/deployment-report');

describe('Deployment Report', () => {
  describe('formatDeploymentReport', () => {
    it('should format a complete report', () => {
      const data = {
        repoName: 'test-app',
        localChecks: {
          factiiiYml: true,
          dockerfile: true,
          git: true,
          branch: 'main',
          workflows: true,
          scripts: true
        },
        secretsCheck: {
          present: ['STAGING_SSH', 'PROD_SSH'],
          missing: ['AWS_ACCESS_KEY_ID'],
          error: null
        },
        serverChecks: [
          {
            environment: 'staging',
            host: '192.168.1.100',
            user: 'admin',
            connected: true,
            infrastructureExists: true,
            allDeployedRepos: [
              { name: 'app1', domain: 'app1.example.com', port: 3001 }
            ],
            currentRepo: {
              deployed: false
            }
          }
        ],
        summary: {
          ready: true,
          warnings: 1,
          errors: 0,
          nextSteps: ['Add missing secret: AWS_ACCESS_KEY_ID']
        }
      };
      
      const report = formatDeploymentReport(data);
      
      expect(report).toContain('DEPLOYMENT READINESS REPORT - test-app');
      expect(report).toContain('✅ LOCAL CONFIGURATION');
      expect(report).toContain('🔑 GITHUB SECRETS');
      expect(report).toContain('✅ STAGING_SSH exists');
      expect(report).toContain('⚠️  AWS_ACCESS_KEY_ID not found');
      expect(report).toContain('📡 STAGING SERVER');
      expect(report).toContain('NOT DEPLOYED');
    });

    it('should handle errors gracefully', () => {
      const data = {
        repoName: 'test-app',
        secretsCheck: {
          error: 'GitHub token is invalid'
        },
        serverChecks: [
          {
            environment: 'staging',
            host: '192.168.1.100',
            user: 'admin',
            error: 'Connection refused'
          }
        ],
        summary: {
          ready: false,
          warnings: 0,
          errors: 2,
          nextSteps: ['Fix GitHub token', 'Fix SSH connection']
        }
      };
      
      const report = formatDeploymentReport(data);
      
      expect(report).toContain('❌ GitHub token is invalid');
      expect(report).toContain('❌ Connection refused');
      expect(report).toContain('NOT READY');
    });
  });

  describe('generateSummary', () => {
    it('should generate ready summary with no issues', () => {
      const localChecks = { factiiiYml: true, workflows: true };
      const secretsCheck = { present: ['ALL'], missing: [], error: null };
      const serverChecks = [
        { connected: true, error: null }
      ];
      
      const summary = generateSummary(localChecks, secretsCheck, serverChecks);
      
      expect(summary.ready).toBe(true);
      expect(summary.warnings).toBe(0);
      expect(summary.errors).toBe(0);
      expect(summary.nextSteps.length).toBeGreaterThan(0);
    });

    it('should detect missing secrets as warnings', () => {
      const localChecks = { factiiiYml: true };
      const secretsCheck = { 
        present: ['STAGING_SSH'], 
        missing: ['PROD_SSH', 'AWS_ACCESS_KEY_ID'],
        error: null 
      };
      const serverChecks = [];
      
      const summary = generateSummary(localChecks, secretsCheck, serverChecks);
      
      expect(summary.warnings).toBe(2);
      expect(summary.nextSteps).toContain('Add missing GitHub secret: PROD_SSH');
      expect(summary.nextSteps).toContain('Add missing GitHub secret: AWS_ACCESS_KEY_ID');
    });

    it('should detect connection errors', () => {
      const localChecks = { factiiiYml: true };
      const secretsCheck = { present: [], missing: [], error: null };
      const serverChecks = [
        { environment: 'staging', connected: false, error: 'Connection failed' }
      ];
      
      const summary = generateSummary(localChecks, secretsCheck, serverChecks);
      
      expect(summary.ready).toBe(false);
      expect(summary.errors).toBeGreaterThan(0);
    });
  });

  describe('formatWorkflowSummary', () => {
    it('should wrap report in code block', () => {
      const data = {
        repoName: 'test-app',
        summary: {
          ready: true,
          warnings: 0,
          errors: 0,
          nextSteps: []
        }
      };
      
      const summary = formatWorkflowSummary(data);
      
      expect(summary).toContain('```');
      expect(summary).toContain('test-app');
    });
  });

  describe('formatLocalChecks', () => {
    it('should format audit results', () => {
      const auditResults = {
        factiiiYml: { exists: true, parseError: null, needsCustomization: false },
        workflows: { allExist: true },
        branches: { hasGit: true, currentBranch: 'main' },
        repoScripts: { 
          hasPackageJson: true,
          requiredScripts: { test: true, 'test:server': true }
        }
      };
      
      const checks = formatLocalChecks(auditResults);
      
      expect(checks.factiiiYml).toBe(true);
      expect(checks.git).toBe(true);
      expect(checks.branch).toBe('main');
      expect(checks.workflows).toBe(true);
      expect(checks.scripts).toBe(true);
    });
  });
});





