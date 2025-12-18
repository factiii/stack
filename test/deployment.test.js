const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { scanRepos, loadConfigs, generateDockerCompose, generateNginx } = require('../src/scripts/generate-all');

describe('Deployment Simulation Test', () => {
  const testFactiiiDir = path.join(__dirname, 'temp-factiii-deployment');
  const fixturesDir = path.join(__dirname, 'fixtures');

  // Store original env
  const originalFactiiiDir = process.env.FACTIII_DIR;

  beforeEach(() => {
    // Create temp factiii directory structure
    if (!fs.existsSync(testFactiiiDir)) {
      fs.mkdirSync(testFactiiiDir, { recursive: true });
    }
    // Set FACTIII_DIR to use our test directory
    process.env.FACTIII_DIR = testFactiiiDir;
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testFactiiiDir)) {
      fs.rmSync(testFactiiiDir, { recursive: true, force: true });
    }
    // Restore original env
    if (originalFactiiiDir) {
      process.env.FACTIII_DIR = originalFactiiiDir;
    } else {
      delete process.env.FACTIII_DIR;
    }
  });

  function createTestRepo(repoName, fixtureName) {
    const repoDir = path.join(testFactiiiDir, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.copyFileSync(
      path.join(fixturesDir, fixtureName),
      path.join(repoDir, 'factiii.yml')
    );
    return repoDir;
  }

  function regenerateConfigs() {
    const repos = scanRepos();
    const configs = loadConfigs(repos);
    generateDockerCompose(configs);
    generateNginx(configs);
    return { repos, configs };
  }

  function readGeneratedCompose() {
    const composePath = path.join(testFactiiiDir, 'docker-compose.yml');
    if (!fs.existsSync(composePath)) return null;
    return fs.readFileSync(composePath, 'utf8');
  }

  function readGeneratedNginx() {
    const nginxPath = path.join(testFactiiiDir, 'nginx.conf');
    if (!fs.existsSync(nginxPath)) return null;
    return fs.readFileSync(nginxPath, 'utf8');
  }

  function countAppServices(content) {
    // Count app service entries (service lines that end with -staging: or -prod:)
    const matches = content.match(/^\s+[a-z0-9-]+-(?:staging|prod):$/gm);
    return matches ? matches.length : 0;
  }

  function countNginxServerBlocks(content) {
    // Count server blocks (listen 80 lines, excluding comments)
    const matches = content.match(/listen 80;/g);
    return matches ? matches.length : 0;
  }

  describe('Phase 1: Deploy repo1', () => {
    test('deploys single repo and generates correct configs', () => {
      createTestRepo('repo1', 'repo1.yml');
      regenerateConfigs();

      const composeContent = readGeneratedCompose();
      const nginxContent = readGeneratedNginx();

      expect(composeContent).not.toBeNull();
      expect(nginxContent).not.toBeNull();

      // Validate docker-compose
      expect(composeContent).toContain('nginx:');
      expect(composeContent).toContain('repo1-staging:');
      expect(composeContent).not.toContain('repo2-staging:');

      // Validate nginx
      expect(composeContent).toContain('repo1-staging:');
      expect(nginxContent).toContain('test-repo1.local');
      expect(nginxContent).not.toContain('test-repo2.local');
    });
  });

  describe('Phase 2: Add repo2', () => {
    test('adds second repo and both repos exist', () => {
      createTestRepo('repo1', 'repo1.yml');
      createTestRepo('repo2', 'repo2.yml');
      regenerateConfigs();

      const composeContent = readGeneratedCompose();
      const nginxContent = readGeneratedNginx();

      // Validate both repos exist
      expect(composeContent).toContain('repo1-staging:');
      expect(composeContent).toContain('repo2-staging:');

      // Validate both domains in nginx
      expect(nginxContent).toContain('test-repo1.local');
      expect(nginxContent).toContain('test-repo2.local');
    });
  });

  describe('Phase 3: Remove repo2', () => {
    test('removes repo2 and repo1 remains', () => {
      // Start with both repos
      createTestRepo('repo1', 'repo1.yml');
      createTestRepo('repo2', 'repo2.yml');
      regenerateConfigs();

      // Remove repo2
      fs.rmSync(path.join(testFactiiiDir, 'repo2'), { recursive: true, force: true });
      regenerateConfigs();

      const composeContent = readGeneratedCompose();
      const nginxContent = readGeneratedNginx();

      // Validate repo1 still exists
      expect(composeContent).toContain('repo1-staging:');
      expect(nginxContent).toContain('test-repo1.local');

      // Validate repo2 is completely removed
      expect(composeContent).not.toContain('repo2-staging:');
      expect(nginxContent).not.toContain('test-repo2.local');
    });
  });

  describe('Phase 4: Remove repo1', () => {
    test('removes repo1 and no repos remain', () => {
      // Start with repo1 only
      createTestRepo('repo1', 'repo1.yml');
      regenerateConfigs();

      // Remove repo1
      fs.rmSync(path.join(testFactiiiDir, 'repo1'), { recursive: true, force: true });

      // Verify no repos remain
      const repos = scanRepos();
      expect(repos.length).toBe(0);
    });
  });

  describe('Full lifecycle integration', () => {
    test('simulates complete deployment lifecycle', () => {
      // Phase 1: Deploy repo1
      createTestRepo('repo1', 'repo1.yml');
      regenerateConfigs();
      
      let composeContent = readGeneratedCompose();
      expect(countAppServices(composeContent)).toBe(1);

      // Phase 2: Add repo2
      createTestRepo('repo2', 'repo2.yml');
      regenerateConfigs();
      
      composeContent = readGeneratedCompose();
      expect(countAppServices(composeContent)).toBe(2);

      // Phase 3: Remove repo2
      fs.rmSync(path.join(testFactiiiDir, 'repo2'), { recursive: true, force: true });
      regenerateConfigs();
      
      composeContent = readGeneratedCompose();
      expect(countAppServices(composeContent)).toBe(1);
      expect(composeContent).toContain('repo1-staging:');
      expect(composeContent).not.toContain('repo2-staging:');

      // Phase 4: Remove repo1
      fs.rmSync(path.join(testFactiiiDir, 'repo1'), { recursive: true, force: true });
      
      // Verify no repos remain
      const repos = scanRepos();
      expect(repos.length).toBe(0);
    });
  });
});
