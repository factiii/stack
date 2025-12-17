/**
 * Basic EC2 Configuration
 * 
 * Simple EC2 instance deployment without additional AWS services.
 */

module.exports = {
  name: 'ec2',
  description: 'Basic EC2 instance',
  services: ['ec2'],
  
  defaults: {
    instance_type: 't3.micro',
    storage: 20,  // GB
    ami_filter: 'ubuntu/images/hvm-ssd/ubuntu-*-22.04-amd64-server-*'
  },
  
  // Additional fixes specific to this config
  fixes: [],
  
  /**
   * Deploy using this config
   */
  async deploy(config, environment) {
    // Basic EC2 deployment - container already pulled from ECR
    return { success: true };
  },
  
  /**
   * Scan for issues specific to this config
   */
  async scan(config, environment) {
    return [];
  }
};
