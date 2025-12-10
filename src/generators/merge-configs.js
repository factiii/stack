const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Merge multiple infrastructure configs from a directory
 * @param {string} configsDir - Directory containing individual repo configs
 * @returns {Object} Merged configuration
 */
function mergeConfigs(configsDir) {
  const configs = [];
  const portMap = new Map();
  let nextPort = 3001;

  // Read all YAML files from configs directory
  if (!fs.existsSync(configsDir)) {
    throw new Error(`Configs directory not found: ${configsDir}`);
  }

  const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  
  if (files.length === 0) {
    throw new Error(`No config files found in ${configsDir}`);
  }

  console.log(`📦 Found ${files.length} config file(s)`);

  // Load and validate each config
  for (const file of files) {
    const configPath = path.join(configsDir, file);
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content);

      if (!config.name) {
        console.warn(`⚠️  Skipping ${file}: missing 'name' field`);
        continue;
      }

      if (!config.environments) {
        console.warn(`⚠️  Skipping ${file}: missing 'environments' field`);
        continue;
      }

      configs.push(config);
      console.log(`   ✅ Loaded: ${config.name}`);
    } catch (error) {
      console.warn(`⚠️  Failed to parse ${file}: ${error.message}`);
    }
  }

  // Extract services and assign ports
  const services = [];
  const domainMap = new Map(); // Track domain conflicts

  for (const config of configs) {
    for (const [env, envConfig] of Object.entries(config.environments)) {
      if (!envConfig.domain) {
        console.warn(`⚠️  Skipping ${config.name}/${env}: missing domain`);
        continue;
      }

      // Check for domain conflicts
      if (domainMap.has(envConfig.domain)) {
        const existing = domainMap.get(envConfig.domain);
        throw new Error(
          `Domain conflict: ${envConfig.domain} is used by both ` +
          `${existing.repo}/${existing.env} and ${config.name}/${env}`
        );
      }

      // Assign port
      let port = envConfig.port;
      if (!port) {
        // Auto-assign port
        port = nextPort++;
        while (Array.from(portMap.values()).includes(port)) {
          port = nextPort++;
        }
      } else {
        // Check if specified port is available
        if (portMap.has(port)) {
          const existing = portMap.get(port);
          console.warn(
            `⚠️  Port ${port} conflict: ${config.name}/${env} and ${existing.repo}/${existing.env}. ` +
            `Auto-assigning port ${nextPort}`
          );
          port = nextPort++;
        }
      }

      portMap.set(port, { repo: config.name, env });
      domainMap.set(envConfig.domain, { repo: config.name, env });

      const serviceKey = `${config.name}-${env}`;
      services.push({
        key: serviceKey,
        name: config.name,
        environment: env,
        domain: envConfig.domain,
        port: port,
        healthCheck: envConfig.health_check || '/health',
        dependsOn: envConfig.depends_on || [],
        envFile: envConfig.env_file,
        ecrRegistry: config.ecr_registry,
        ecrRepository: config.ecr_repository || 'apps',
        sslEmail: config.ssl_email
      });
    }
  }

  // Get SSL email (use first one found, warn if multiple)
  const sslEmails = [...new Set(services.map(s => s.sslEmail).filter(Boolean))];
  const sslEmail = sslEmails[0] || 'admin@example.com';
  if (sslEmails.length > 1) {
    console.warn(`⚠️  Multiple SSL emails found, using: ${sslEmail}`);
  }

  // Get ECR registry/repo (use first one found, warn if multiple)
  const ecrRegistries = [...new Set(services.map(s => s.ecrRegistry).filter(Boolean))];
  const ecrRepositories = [...new Set(services.map(s => s.ecrRepository).filter(Boolean))];
  const ecrRegistry = ecrRegistries[0];
  const ecrRepository = ecrRepositories[0] || 'apps';
  
  if (ecrRegistries.length > 1) {
    console.warn(`⚠️  Multiple ECR registries found, using: ${ecrRegistry}`);
  }

  return {
    services,
    sslEmail,
    ecrRegistry,
    ecrRepository,
    portMap: Object.fromEntries(portMap)
  };
}

module.exports = mergeConfigs;


