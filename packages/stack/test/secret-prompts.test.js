const {
  getSecretMetadata,
  formatSecretHelp,
  validateSecretFormat
} = require('../src/utils/secret-prompts');

describe('Secret Prompts Utilities', () => {
  describe('getSecretMetadata', () => {
    it('should return metadata for STAGING_SSH', () => {
      const metadata = getSecretMetadata('STAGING_SSH');
      
      expect(metadata.type).toBe('ssh_key');
      expect(metadata.description).toContain('SSH private key');
      expect(metadata.helpText).toContain('ssh-keygen');
      expect(metadata.validation).toBeDefined();
    });

    it('should return metadata for AWS_ACCESS_KEY_ID', () => {
      const metadata = getSecretMetadata('AWS_ACCESS_KEY_ID');
      
      expect(metadata.type).toBe('aws_key');
      expect(metadata.description).toContain('AWS Access Key');
      expect(metadata.helpText).toContain('AKIA');
      expect(metadata.validation).toBeDefined();
    });

    it('should return generic metadata for unknown secrets', () => {
      const metadata = getSecretMetadata('UNKNOWN_SECRET');
      
      expect(metadata.type).toBe('generic');
      expect(metadata.description).toContain('UNKNOWN_SECRET');
      expect(metadata.validation).toBeDefined();
    });

    it('should have metadata for all required secret types', () => {
      // Updated for simplified secrets (SSH keys and AWS secret only in GitHub)
      const secretTypes = [
        'STAGING_SSH',
        'PROD_SSH',
        'AWS_SECRET_ACCESS_KEY'
      ];
      
      secretTypes.forEach(secret => {
        const metadata = getSecretMetadata(secret);
        expect(metadata).toBeDefined();
        expect(metadata.type).toBeDefined();
        expect(metadata.description).toBeDefined();
        expect(metadata.helpText).toBeDefined();
        expect(metadata.validation).toBeDefined();
      });
    });
  });

  describe('formatSecretHelp', () => {
    it('should format help text for SSH keys', () => {
      const help = formatSecretHelp('STAGING_SSH');
      
      expect(help).toContain('🔑 STAGING_SSH');
      expect(help).toContain('ssh-keygen');
      expect(help).toContain('authorized_keys');
    });

    it('should format help text for AWS credentials', () => {
      const help = formatSecretHelp('AWS_ACCESS_KEY_ID');
      
      expect(help).toContain('🔑 AWS_ACCESS_KEY_ID');
      expect(help).toContain('AWS');
      expect(help).toContain('AKIA');
    });

    it('should format help text for hostnames', () => {
      const help = formatSecretHelp('STAGING_HOST');
      
      expect(help).toContain('🔑 STAGING_HOST');
      expect(help).toContain('hostname');
    });
  });

  describe('validateSecretFormat', () => {
    describe('SSH Keys', () => {
      it('should validate valid SSH key', () => {
        const validKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----`;
        
        const result = validateSecretFormat('STAGING_SSH', validKey);
        expect(result.valid).toBe(true);
      });

      it('should reject empty SSH key', () => {
        const result = validateSecretFormat('STAGING_SSH', '');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should reject invalid SSH key format', () => {
        const result = validateSecretFormat('STAGING_SSH', 'not-a-valid-key');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid SSH key format');
      });
    });

    describe('AWS Access Key ID', () => {
      it('should validate valid AWS key', () => {
        const result = validateSecretFormat('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
        expect(result.valid).toBe(true);
      });

      it('should reject empty AWS key', () => {
        const result = validateSecretFormat('AWS_ACCESS_KEY_ID', '');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should reject AWS key not starting with AKIA', () => {
        const result = validateSecretFormat('AWS_ACCESS_KEY_ID', 'WRONGIOSFODNN7EXAMPL');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('should start with AKIA');
      });

      it('should reject AWS key with wrong length', () => {
        const result = validateSecretFormat('AWS_ACCESS_KEY_ID', 'AKIA123');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('20 characters');
      });
    });

    describe('AWS Secret Access Key', () => {
      it('should validate valid AWS secret', () => {
        const validSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
        const result = validateSecretFormat('AWS_SECRET_ACCESS_KEY', validSecret);
        expect(result.valid).toBe(true);
      });

      it('should reject empty AWS secret', () => {
        const result = validateSecretFormat('AWS_SECRET_ACCESS_KEY', '');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should reject AWS secret with wrong length', () => {
        const result = validateSecretFormat('AWS_SECRET_ACCESS_KEY', 'tooshort');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('40 characters');
      });
    });

    describe('AWS Region', () => {
      it('should validate valid regions', () => {
        const validRegions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
        
        validRegions.forEach(region => {
          const result = validateSecretFormat('AWS_REGION', region);
          expect(result.valid).toBe(true);
        });
      });

      it('should reject empty region', () => {
        const result = validateSecretFormat('AWS_REGION', '');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should reject invalid region format', () => {
        const result = validateSecretFormat('AWS_REGION', 'invalid-region');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid AWS region format');
      });
    });

    describe('Hostnames', () => {
      it('should validate valid hostnames', () => {
        const validHosts = [
          'staging.example.com',
          '192.168.1.100',
          'ec2-12-34-56-78.compute-1.amazonaws.com'
        ];
        
        validHosts.forEach(host => {
          const result = validateSecretFormat('STAGING_HOST', host);
          expect(result.valid).toBe(true);
        });
      });

      it('should reject empty hostname', () => {
        const result = validateSecretFormat('STAGING_HOST', '');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot be empty');
      });

      it('should reject hostname with spaces', () => {
        const result = validateSecretFormat('STAGING_HOST', 'host with spaces');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot contain spaces');
      });
    });

    describe('Usernames', () => {
      it('should validate valid usernames', () => {
        const validUsers = ['ubuntu', 'admin', 'deploy', 'ec2-user'];
        
        validUsers.forEach(user => {
          const result = validateSecretFormat('STAGING_USER', user);
          expect(result.valid).toBe(true);
        });
      });

      it('should allow empty username with default', () => {
        const result = validateSecretFormat('STAGING_USER', '');
        expect(result.valid).toBe(true);
        expect(result.defaultValue).toBe('ubuntu');
      });

      it('should reject username with spaces', () => {
        const result = validateSecretFormat('STAGING_USER', 'user name');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cannot contain spaces');
      });
    });
  });

  describe('Integration - Complete validation flow', () => {
    it('should validate all secret types correctly', () => {
      const testCases = [
        {
          name: 'STAGING_SSH',
          valid: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----',
          invalid: 'not-a-key'
        },
        {
          name: 'AWS_ACCESS_KEY_ID',
          valid: 'AKIAIOSFODNN7EXAMPLE',
          invalid: 'NOTAKIA123'
        },
        {
          name: 'AWS_REGION',
          valid: 'us-east-1',
          invalid: 'invalid'
        },
        {
          name: 'STAGING_HOST',
          valid: '192.168.1.1',
          invalid: 'host with spaces'
        }
      ];
      
      testCases.forEach(testCase => {
        // Valid case
        const validResult = validateSecretFormat(testCase.name, testCase.valid);
        expect(validResult.valid).toBe(true);
        
        // Invalid case
        const invalidResult = validateSecretFormat(testCase.name, testCase.invalid);
        expect(invalidResult.valid).toBe(false);
        expect(invalidResult.error).toBeDefined();
      });
    });
  });
});
