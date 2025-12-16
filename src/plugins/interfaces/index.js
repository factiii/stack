/**
 * Plugin Interface Exports
 * 
 * These are the base classes that all plugins must extend.
 */

const ServerProvider = require('./server-provider');
const SecretStore = require('./secret-store');
const RegistryProvider = require('./registry-provider');
const AppFramework = require('./app-framework');
const Addon = require('./addon');
const Pipeline = require('./pipeline');

module.exports = {
  ServerProvider,
  SecretStore,
  RegistryProvider,
  AppFramework,
  Addon,
  Pipeline
};

