/**
 * Infrastructure Package
 * Main entry point for programmatic usage
 */

module.exports = {
  mergeConfigs: require('./generators/merge-configs'),
  generateCompose: require('./generators/generate-compose'),
  generateNginx: require('./generators/generate-nginx')
};


