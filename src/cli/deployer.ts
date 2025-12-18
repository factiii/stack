/**
 * Deployer Module
 *
 * Handles the actual deployment logic
 */

import { deploy } from './deploy.js';
import type { FactiiiConfig, DeployOptions, DeployResult } from '../types/index.js';

export class Deployer {
  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  async deployToEnvironment(
    environment: string,
    options: DeployOptions = {}
  ): Promise<DeployResult> {
    return deploy(environment, options);
  }
}

export default Deployer;

