const fs = require('fs');
const path = require('path');
const generateCompose = require('../src/generators/generate-compose');
const generateNginx = require('../src/generators/generate-nginx');

describe('Deployment Simulation Test', () => {
  const testConfigsDir = path.join(__dirname, 'temp-deployment-configs');
  const composeOutput = path.join(__dirname, 'temp-deployment-compose.yml');
  const nginxOutput = path.join(__dirname, 'temp-deployment-nginx.conf');
  const fixturesDir = path.join(__dirname, 'fixtures');

  beforeEach(() => {
    // Create temp configs directory
    if (!fs.existsSync(testConfigsDir)) {
      fs.mkdirSync(testConfigsDir, { recursive: true });
    }
    // Clean up any existing output files
    [composeOutput, nginxOutput].forEach(file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  });

  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(composeOutput)) fs.unlinkSync(composeOutput);
    if (fs.existsSync(nginxOutput)) fs.unlinkSync(nginxOutput);
    if (fs.existsSync(path.dirname(nginxOutput))) {
      const nginxDir = path.dirname(nginxOutput);
      try {
        if (fs.readdirSync(nginxDir).length === 0) {
          fs.rmdirSync(nginxDir);
        }
      } catch (e) {
        // Ignore errors
      }
    }
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(testConfigsDir)) {
      fs.rmSync(testConfigsDir, { recursive: true, force: true });
    }
  });

  function readGeneratedFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  }

  function validateDockerCompose(content, expectedServices, shouldNotContain = []) {
    // Check for infrastructure services
    expect(content).toContain('nginx:');
    expect(content).toContain('certbot:');
    expect(content).toContain('postgres-staging:');

    // Check for expected app services
    expectedServices.forEach(service => {
      expect(content).toContain(`${service}:`);
      expect(content).toContain(`# ${service.replace('-staging', '').replace('-prod', '')}`);
    });

    // Check that removed services are not present
    shouldNotContain.forEach(service => {
      expect(content).not.toContain(`${service}:`);
    });
  }

  function validateNginxConfig(content, expectedDomains, shouldNotContain = []) {
    // Check HTTP server block exists
    expect(content).toContain('listen 80;');
    expect(content).toContain('/.well-known/acme-challenge/');
    expect(content).toContain('return 301 https://$host$request_uri;');

    // Check for expected server blocks
    expectedDomains.forEach(domain => {
      expect(content).toContain(`server_name ${domain};`);
      expect(content).toContain(`ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;`);
    });

    // Check that removed domains are not present
    shouldNotContain.forEach(domain => {
      // Should not have server block for removed domain
      const domainServerBlock = content.match(new RegExp(`server_name ${domain.replace(/\./g, '\\.')};`));
      expect(domainServerBlock).toBeNull();
    });
  }

  function countServiceBlocks(content) {
    // Count HTTPS server blocks (excluding the HTTP redirect block)
    const matches = content.match(/listen 443 ssl http2;/g);
    return matches ? matches.length : 0;
  }

  function countAppServices(content) {
    // Count app service entries (exclude nginx, certbot, postgres-staging)
    const serviceMatches = content.match(/^  [a-z0-9-]+:$/gm);
    if (!serviceMatches) return 0;
    return serviceMatches.filter(s => 
      !s.includes('nginx') && 
      !s.includes('certbot') && 
      !s.includes('postgres-staging')
    ).length;
  }

  describe('Phase 1: Deploy repo1', () => {
    test('deploys single repo and generates correct configs', () => {
      // Copy repo1 fixture
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testConfigsDir, 'repo1.yml')
      );

      // Generate configs
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);

      const composeContent = readGeneratedFile(composeOutput);
      const nginxContent = readGeneratedFile(nginxOutput);

      expect(composeContent).not.toBeNull();
      expect(nginxContent).not.toBeNull();

      // Validate docker-compose
      validateDockerCompose(composeContent, ['test-repo1-staging'], ['test-repo2-staging']);

      // Validate nginx
      validateNginxConfig(nginxContent, ['test-repo1.local'], ['test-repo2.local']);

      // Verify port assignment
      expect(composeContent).toMatch(/http:\/\/localhost:3001\/health/);
      expect(nginxContent).toContain('proxy_pass http://test-repo1-staging:3001;');

      // Verify only one app service
      expect(countAppServices(composeContent)).toBe(1);
      expect(countServiceBlocks(nginxContent)).toBe(1);
    });
  });

  describe('Phase 2: Add repo2', () => {
    test('adds second repo and both repos exist', () => {
      // Copy both repos
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testConfigsDir, 'repo1.yml')
      );
      fs.copyFileSync(
        path.join(fixturesDir, 'repo2.yml'),
        path.join(testConfigsDir, 'repo2.yml')
      );

      // Regenerate configs
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);

      const composeContent = readGeneratedFile(composeOutput);
      const nginxContent = readGeneratedFile(nginxOutput);

      // Validate both repos exist
      validateDockerCompose(composeContent, ['test-repo1-staging', 'test-repo2-staging'], []);

      // Validate both domains in nginx
      validateNginxConfig(nginxContent, ['test-repo1.local', 'test-repo2.local'], []);

      // Verify ports are sequential
      expect(composeContent).toMatch(/http:\/\/localhost:3001\/health/);
      expect(composeContent).toMatch(/http:\/\/localhost:3002\/health/);
      expect(nginxContent).toContain('proxy_pass http://test-repo1-staging:3001;');
      expect(nginxContent).toContain('proxy_pass http://test-repo2-staging:3002;');

      // Verify two app services
      expect(countAppServices(composeContent)).toBe(2);
      expect(countServiceBlocks(nginxContent)).toBe(2);

      // Verify certbot includes both domains
      expect(composeContent).toContain('-d test-repo1.local');
      expect(composeContent).toContain('-d test-repo2.local');
    });
  });

  describe('Phase 3: Remove repo2', () => {
    test('removes repo2 and repo1 remains', () => {
      // Start with both repos
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testConfigsDir, 'repo1.yml')
      );
      fs.copyFileSync(
        path.join(fixturesDir, 'repo2.yml'),
        path.join(testConfigsDir, 'repo2.yml')
      );

      // Generate initial configs
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);

      // Remove repo2
      fs.unlinkSync(path.join(testConfigsDir, 'repo2.yml'));

      // Regenerate configs
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);

      const composeContent = readGeneratedFile(composeOutput);
      const nginxContent = readGeneratedFile(nginxOutput);

      // Validate repo1 still exists
      validateDockerCompose(composeContent, ['test-repo1-staging'], ['test-repo2-staging']);

      // Validate repo2 is completely removed
      validateNginxConfig(nginxContent, ['test-repo1.local'], ['test-repo2.local']);

      // Verify repo2 references are gone
      expect(composeContent).not.toContain('test-repo2-staging:');
      expect(composeContent).not.toContain('test-repo2');
      expect(nginxContent).not.toContain('test-repo2.local');
      expect(nginxContent).not.toContain('test-repo2-staging');

      // Verify port is back to 3001
      expect(composeContent).toMatch(/http:\/\/localhost:3001\/health/);
      expect(composeContent).not.toMatch(/http:\/\/localhost:3002\/health/);
      expect(nginxContent).toContain('proxy_pass http://test-repo1-staging:3001;');

      // Verify only one app service remains
      expect(countAppServices(composeContent)).toBe(1);
      expect(countServiceBlocks(nginxContent)).toBe(1);

      // Verify certbot only includes repo1 domain
      expect(composeContent).toContain('-d test-repo1.local');
      expect(composeContent).not.toContain('-d test-repo2.local');
    });
  });

  describe('Phase 4: Remove repo1', () => {
    test('removes repo1 and configs directory is empty', () => {
      // Start with repo1 only
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testConfigsDir, 'repo1.yml')
      );

      // Generate initial configs
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);

      // Remove repo1
      fs.unlinkSync(path.join(testConfigsDir, 'repo1.yml'));

      // Verify configs directory is empty
      const remainingFiles = fs.readdirSync(testConfigsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
      expect(remainingFiles.length).toBe(0);

      // Attempting to regenerate with empty directory should throw an error
      expect(() => {
        generateCompose(testConfigsDir, composeOutput);
      }).toThrow('No config files found');

      expect(() => {
        generateNginx(testConfigsDir, nginxOutput);
      }).toThrow('No config files found');

      // Verify the directory is clean (no config files)
      expect(fs.readdirSync(testConfigsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).length).toBe(0);
    });
  });

  describe('Full lifecycle integration', () => {
    test('simulates complete deployment lifecycle', () => {
      // Phase 1: Deploy repo1
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testConfigsDir, 'repo1.yml')
      );
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);
      
      let composeContent = readGeneratedFile(composeOutput);
      let nginxContent = readGeneratedFile(nginxOutput);
      expect(countAppServices(composeContent)).toBe(1);
      expect(countServiceBlocks(nginxContent)).toBe(1);

      // Phase 2: Add repo2
      fs.copyFileSync(
        path.join(fixturesDir, 'repo2.yml'),
        path.join(testConfigsDir, 'repo2.yml')
      );
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);
      
      composeContent = readGeneratedFile(composeOutput);
      nginxContent = readGeneratedFile(nginxOutput);
      expect(countAppServices(composeContent)).toBe(2);
      expect(countServiceBlocks(nginxContent)).toBe(2);

      // Phase 3: Remove repo2
      fs.unlinkSync(path.join(testConfigsDir, 'repo2.yml'));
      generateCompose(testConfigsDir, composeOutput);
      generateNginx(testConfigsDir, nginxOutput);
      
      composeContent = readGeneratedFile(composeOutput);
      nginxContent = readGeneratedFile(nginxOutput);
      expect(countAppServices(composeContent)).toBe(1);
      expect(countServiceBlocks(nginxContent)).toBe(1);
      expect(composeContent).toContain('test-repo1-staging:');
      expect(composeContent).not.toContain('test-repo2-staging:');

      // Phase 4: Remove repo1
      fs.unlinkSync(path.join(testConfigsDir, 'repo1.yml'));
      
      // Verify configs directory is empty
      const remainingFiles = fs.readdirSync(testConfigsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
      expect(remainingFiles.length).toBe(0);
      
      // Attempting to regenerate with empty directory should throw an error
      expect(() => {
        generateCompose(testConfigsDir, composeOutput);
      }).toThrow('No config files found');
      
      expect(() => {
        generateNginx(testConfigsDir, nginxOutput);
      }).toThrow('No config files found');
    });
  });
});


