const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { scanRepos, loadConfigs, generateDockerCompose, generateNginx } = require('../src/scripts/generate-all');

describe('Generator Tests (generate-all.js)', () => {
  const testFactiiiDir = path.join(__dirname, 'temp-factiii');
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

  function createTestRepo(repoName, config) {
    const repoDir = path.join(testFactiiiDir, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'factiii.yml'), yaml.dump(config));
    return repoDir;
  }

  function loadFixtureConfig(fixtureName) {
    const content = fs.readFileSync(path.join(fixturesDir, fixtureName), 'utf8');
    return yaml.load(content);
  }

  describe('scanRepos', () => {
    test('finds repos with factiii.yml', () => {
      createTestRepo('test-repo1', { name: 'test-repo1', environments: {} });
      createTestRepo('test-repo2', { name: 'test-repo2', environments: {} });
      
      // Create a directory without factiii.yml (should be skipped)
      fs.mkdirSync(path.join(testFactiiiDir, 'no-config'), { recursive: true });
      
      const repos = scanRepos();
      
      expect(repos.length).toBe(2);
      expect(repos.map(r => r.name)).toContain('test-repo1');
      expect(repos.map(r => r.name)).toContain('test-repo2');
    });

    test('skips special directories', () => {
      createTestRepo('test-repo', { name: 'test-repo', environments: {} });
      
      // Create special directories that should be skipped
      fs.mkdirSync(path.join(testFactiiiDir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(testFactiiiDir, 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(testFactiiiDir, '.hidden'), { recursive: true });
      
      const repos = scanRepos();
      
      expect(repos.length).toBe(1);
      expect(repos[0].name).toBe('test-repo');
    });
  });

  describe('loadConfigs', () => {
    test('loads configs from repos', () => {
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      createTestRepo('repo2', loadFixtureConfig('repo2.yml'));
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      
      expect(Object.keys(configs)).toContain('repo1');
      expect(Object.keys(configs)).toContain('repo2');
      expect(configs['repo1'].name).toBe('test-repo1');
      expect(configs['repo2'].name).toBe('test-repo2');
    });
  });

  describe('generateDockerCompose', () => {
    test('generates docker-compose.yml with nginx service', () => {
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      generateDockerCompose(configs);
      
      const composePath = path.join(testFactiiiDir, 'docker-compose.yml');
      expect(fs.existsSync(composePath)).toBe(true);
      
      const content = fs.readFileSync(composePath, 'utf8');
      expect(content).toContain('nginx:');
      expect(content).toContain('image: nginx:alpine');
    });

    test('generates services for each repo environment', () => {
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      generateDockerCompose(configs);
      
      const composePath = path.join(testFactiiiDir, 'docker-compose.yml');
      const content = fs.readFileSync(composePath, 'utf8');
      
      expect(content).toContain('repo1-staging:');
    });

    test('handles multiple repos', () => {
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      createTestRepo('repo2', loadFixtureConfig('repo2.yml'));
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      const serviceCount = generateDockerCompose(configs);
      
      expect(serviceCount).toBe(2); // Both repos have staging environment
      
      const composePath = path.join(testFactiiiDir, 'docker-compose.yml');
      const content = fs.readFileSync(composePath, 'utf8');
      
      expect(content).toContain('repo1-staging:');
      expect(content).toContain('repo2-staging:');
    });
  });

  describe('generateNginx', () => {
    test('generates nginx.conf with server blocks', () => {
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      generateNginx(configs);
      
      const nginxPath = path.join(testFactiiiDir, 'nginx.conf');
      expect(fs.existsSync(nginxPath)).toBe(true);
      
      const content = fs.readFileSync(nginxPath, 'utf8');
      expect(content).toContain('http {');
      expect(content).toContain('server_name test-repo1.local;');
    });

    test('handles multiple repos with different domains', () => {
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      createTestRepo('repo2', loadFixtureConfig('repo2.yml'));
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      const domainCount = generateNginx(configs);
      
      expect(domainCount).toBe(2);
      
      const nginxPath = path.join(testFactiiiDir, 'nginx.conf');
      const content = fs.readFileSync(nginxPath, 'utf8');
      
      expect(content).toContain('server_name test-repo1.local;');
      expect(content).toContain('server_name test-repo2.local;');
    });

    test('skips nginx generation when no domains configured', () => {
      createTestRepo('repo1', { 
        name: 'test-repo', 
        environments: { 
          staging: { host: '192.168.1.1' } // No domain
        } 
      });
      
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      const domainCount = generateNginx(configs);
      
      expect(domainCount).toBe(0);
    });
  });

  describe('Full lifecycle', () => {
    test('deploy repo1, add repo2, remove repo2, remove repo1', () => {
      // Phase 1: Deploy repo1
      createTestRepo('repo1', loadFixtureConfig('repo1.yml'));
      
      let repos = scanRepos();
      let configs = loadConfigs(repos);
      generateDockerCompose(configs);
      generateNginx(configs);
      
      let composePath = path.join(testFactiiiDir, 'docker-compose.yml');
      let content = fs.readFileSync(composePath, 'utf8');
      expect(content).toContain('repo1-staging:');
      expect(content).not.toContain('repo2-staging:');
      
      // Phase 2: Add repo2
      createTestRepo('repo2', loadFixtureConfig('repo2.yml'));
      
      repos = scanRepos();
      configs = loadConfigs(repos);
      generateDockerCompose(configs);
      generateNginx(configs);
      
      content = fs.readFileSync(composePath, 'utf8');
      expect(content).toContain('repo1-staging:');
      expect(content).toContain('repo2-staging:');
      
      // Phase 3: Remove repo2
      fs.rmSync(path.join(testFactiiiDir, 'repo2'), { recursive: true, force: true });
      
      repos = scanRepos();
      configs = loadConfigs(repos);
      generateDockerCompose(configs);
      generateNginx(configs);
      
      content = fs.readFileSync(composePath, 'utf8');
      expect(content).toContain('repo1-staging:');
      expect(content).not.toContain('repo2-staging:');
      
      // Phase 4: Remove repo1
      fs.rmSync(path.join(testFactiiiDir, 'repo1'), { recursive: true, force: true });
      
      repos = scanRepos();
      expect(repos.length).toBe(0);
    });
  });
});
