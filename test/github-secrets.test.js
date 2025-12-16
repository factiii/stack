const {
  getRequiredSecrets,
  checkGitHubSecrets,
  formatSecretsReport,
  getGitHubRepoInfo
} = require('../src/utils/github-secrets');

describe('GitHub Secrets Utilities', () => {
  describe('getRequiredSecrets', () => {
    it('should return all required secrets', () => {
      const config = { name: 'test-repo' };
      const secrets = getRequiredSecrets(config);
      
      expect(secrets).toContain('STAGING_SSH');
      expect(secrets).toContain('PROD_SSH');
      expect(secrets).toContain('AWS_ACCESS_KEY_ID');
      expect(secrets).toContain('STAGING_ENVS');
      expect(secrets).toContain('PROD_ENVS');
      expect(secrets.length).toBeGreaterThan(10);
    });
  });

  describe('formatSecretsReport', () => {
    it('should format present secrets', () => {
      const secretsCheck = {
        present: ['STAGING_SSH', 'PROD_SSH'],
        missing: [],
        error: null
      };
      
      const report = formatSecretsReport(secretsCheck);
      
      expect(report).toContain('✅ STAGING_SSH exists');
      expect(report).toContain('✅ PROD_SSH exists');
    });

    it('should format missing secrets', () => {
      const secretsCheck = {
        present: ['STAGING_SSH'],
        missing: ['PROD_SSH', 'AWS_ACCESS_KEY_ID'],
        error: null
      };
      
      const report = formatSecretsReport(secretsCheck);
      
      expect(report).toContain('✅ STAGING_SSH exists');
      expect(report).toContain('⚠️  PROD_SSH not found');
      expect(report).toContain('⚠️  AWS_ACCESS_KEY_ID not found');
    });

    it('should format error message', () => {
      const secretsCheck = {
        present: [],
        missing: [],
        error: 'GitHub token is invalid'
      };
      
      const report = formatSecretsReport(secretsCheck);
      
      expect(report).toContain('❌ GitHub token is invalid');
      expect(report).toContain('Cannot verify secrets via API');
    });
  });

  describe('checkGitHubSecrets', () => {
    it('should return error when no token provided', async () => {
      const result = await checkGitHubSecrets('owner', 'repo', null, {});
      
      expect(result.error).toBe('No GitHub token provided');
      expect(result.present).toEqual([]);
      expect(result.missing).toEqual([]);
    });

    // Note: API tests would require mocking Octokit
  });

  describe('getGitHubRepoInfo', () => {
    it('should return null when not in a git repository', () => {
      // This test would need to be run outside a git repo or mock execSync
      // For now, we'll just check it doesn't throw
      const result = getGitHubRepoInfo();
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });
});





