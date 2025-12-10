const fs = require('fs');
const path = require('path');
const generateCompose = require('../src/generators/generate-compose');
const generateNginx = require('../src/generators/generate-nginx');

describe('Generator Tests', () => {
  const testDir = path.join(__dirname, 'temp-test-configs');
  const composeOutput = path.join(__dirname, 'temp-docker-compose.yml');
  const nginxOutput = path.join(__dirname, 'temp-nginx.conf');
  const fixturesDir = path.join(__dirname, 'fixtures');

  beforeEach(() => {
    // Create temp configs directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
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
      if (fs.readdirSync(nginxDir).length === 0) {
        fs.rmdirSync(nginxDir);
      }
    }
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Docker Compose Generation', () => {
    test('generates docker-compose.yml with required services', () => {
      // Copy repo1 fixture
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);

      expect(fs.existsSync(composeOutput)).toBe(true);
      const content = fs.readFileSync(composeOutput, 'utf8');

      // Check for required services
      expect(content).toContain('services:');
      expect(content).toContain('nginx:');
      expect(content).toContain('certbot:');
      expect(content).toContain('postgres-staging:');
    });

    test('nginx service has correct configuration', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('image: nginx:alpine');
      expect(content).toContain('container_name: infrastructure_nginx');
      expect(content).toContain('"80:80"');
      expect(content).toContain('"443:443"');
      expect(content).toContain('./nginx/nginx.conf:/etc/nginx/nginx.conf:ro');
      expect(content).toContain('certbot-www:/var/www/certbot:ro');
      expect(content).toContain('certbot-conf:/etc/letsencrypt:ro');
      expect(content).toContain('infrastructure_network');
      expect(content).toContain('depends_on:');
      expect(content).toContain('certbot');
      expect(content).toContain('test: ["CMD", "nginx", "-t"]');
    });

    test('certbot service includes all domains', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );
      fs.copyFileSync(
        path.join(fixturesDir, 'repo2.yml'),
        path.join(testDir, 'repo2.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('certbot:');
      expect(content).toContain('image: certbot/certbot');
      expect(content).toContain('-d test-repo1.local');
      expect(content).toContain('-d test-repo2.local');
    });

    test('postgres-staging service has correct configuration', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('postgres-staging:');
      expect(content).toContain('image: postgres:15-alpine');
      expect(content).toContain('container_name: infrastructure_postgres_staging');
      expect(content).toContain('"5432:5432"');
      expect(content).toContain('postgres-staging-data:/var/lib/postgresql/data');
      expect(content).toContain('test: ["CMD-SHELL", "pg_isready');
    });

    test('generates service entries for each repo/environment', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('test-repo1-staging:');
      expect(content).toContain('# test-repo1 - staging');
    });

    test('service entries have correct image tags', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('image: 123456789.dkr.ecr.us-east-1.amazonaws.com/test-apps:test-repo1-main-latest');
    });

    test('ports are assigned sequentially starting at 3001', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      // Check that port 3001 is used in healthcheck
      expect(content).toMatch(/http:\/\/localhost:3001\/health/);
    });

    test('staging services depend on postgres-staging', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      const serviceSection = content.split('test-repo1-staging:')[1].split('\n\n')[0];
      expect(serviceSection).toContain('depends_on:');
      expect(serviceSection).toContain('postgres-staging:');
      expect(serviceSection).toContain('condition: service_healthy');
    });

    test('healthchecks are configured correctly', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('healthcheck:');
      expect(content).toMatch(/test: \["CMD", "curl", "-f", "http:\/\/localhost:\d+\/health"\]/);
      expect(content).toContain('interval: 30s');
      expect(content).toContain('timeout: 10s');
      expect(content).toContain('retries: 3');
      expect(content).toContain('start_period: 40s');
    });

    test('networks and volumes are defined', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('volumes:');
      expect(content).toContain('postgres-staging-data:');
      expect(content).toContain('certbot-www:');
      expect(content).toContain('certbot-conf:');
      expect(content).toContain('networks:');
      expect(content).toContain('infrastructure_network:');
      expect(content).toContain('driver: bridge');
    });

    test('handles multiple repos correctly', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );
      fs.copyFileSync(
        path.join(fixturesDir, 'repo2.yml'),
        path.join(testDir, 'repo2.yml')
      );

      generateCompose(testDir, composeOutput);
      const content = fs.readFileSync(composeOutput, 'utf8');

      expect(content).toContain('test-repo1-staging:');
      expect(content).toContain('test-repo2-staging:');
      // Check ports are sequential
      expect(content).toMatch(/http:\/\/localhost:3001\/health/);
      expect(content).toMatch(/http:\/\/localhost:3002\/health/);
    });
  });

  describe('Nginx Configuration Generation', () => {
    test('generates nginx.conf with http block', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('http {');
      expect(content).toContain('user nginx;');
      expect(content).toContain('worker_processes auto;');
    });

    test('has HTTP server on port 80 with ACME challenge', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('listen 80;');
      expect(content).toContain('server_name _;');
      expect(content).toContain('/.well-known/acme-challenge/');
      expect(content).toContain('root /var/www/certbot;');
    });

    test('has HTTPS redirect (301)', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('return 301 https://$host$request_uri;');
    });

    test('generates server blocks for each service', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('# test-repo1 - staging');
      expect(content).toContain('server_name test-repo1.local;');
    });

    test('server blocks have SSL configuration', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('listen 443 ssl http2;');
      expect(content).toContain('ssl_certificate /etc/letsencrypt/live/test-repo1.local/fullchain.pem;');
      expect(content).toContain('ssl_certificate_key /etc/letsencrypt/live/test-repo1.local/privkey.pem;');
      expect(content).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
      expect(content).toContain('ssl_ciphers HIGH:!aNULL:!MD5;');
      expect(content).toContain('ssl_prefer_server_ciphers on;');
    });

    test('has security headers', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('add_header X-Frame-Options "SAMEORIGIN" always;');
      expect(content).toContain('add_header X-Content-Type-Options "nosniff" always;');
      expect(content).toContain('add_header X-XSS-Protection "1; mode=block" always;');
    });

    test('has rate limiting configured', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;');
      expect(content).toContain('limit_req zone=api_limit burst=20 nodelay;');
    });

    test('proxy_pass points to correct service and port', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('proxy_pass http://test-repo1-staging:3001;');
    });

    test('proxy configuration is complete', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('proxy_http_version 1.1;');
      expect(content).toContain('proxy_set_header Upgrade $http_upgrade;');
      expect(content).toContain('proxy_set_header Connection \'upgrade\';');
      expect(content).toContain('proxy_set_header Host $host;');
      expect(content).toContain('proxy_set_header X-Real-IP $remote_addr;');
      expect(content).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
      expect(content).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
      expect(content).toContain('proxy_read_timeout 300s;');
      expect(content).toContain('proxy_connect_timeout 75s;');
    });

    test('handles multiple repos correctly', () => {
      fs.copyFileSync(
        path.join(fixturesDir, 'repo1.yml'),
        path.join(testDir, 'repo1.yml')
      );
      fs.copyFileSync(
        path.join(fixturesDir, 'repo2.yml'),
        path.join(testDir, 'repo2.yml')
      );

      generateNginx(testDir, nginxOutput);
      const content = fs.readFileSync(nginxOutput, 'utf8');

      expect(content).toContain('server_name test-repo1.local;');
      expect(content).toContain('server_name test-repo2.local;');
      expect(content).toContain('proxy_pass http://test-repo1-staging:3001;');
      expect(content).toContain('proxy_pass http://test-repo2-staging:3002;');
    });
  });
});


