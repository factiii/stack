const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get Factiii package version
function getFactiiiVersion() {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return pkg.version || '1.0.0';
  } catch (e) {
    return '1.0.0';
  }
}

/**
 * Detect Next.js in the project
 */
function detectNextJs(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };
    return !!allDeps.next;
  } catch (e) {
    return false;
  }
}

/**
 * Detect Expo in the project
 */
function detectExpo(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };
    return !!allDeps.expo;
  } catch (e) {
    return false;
  }
}

/**
 * Detect tRPC in the project
 */
function detectTrpc(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };
    return !!(allDeps['@trpc/server'] || allDeps['@trpc/client']);
  } catch (e) {
    return false;
  }
}

/**
 * Detect Prisma in the project
 */
function detectPrisma(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { found: false };
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };
    
    const hasPrisma = !!(allDeps.prisma || allDeps['@prisma/client']);
    if (!hasPrisma) {
      return { found: false };
    }
    
    // Find schema path
    const schemaPath = findPrismaSchema(rootDir);
    
    // Get version
    const version = allDeps.prisma || allDeps['@prisma/client'];
    const cleanVersion = version ? version.replace(/^[\^~]/, '') : null;
    
    return {
      found: true,
      schemaPath,
      version: cleanVersion
    };
  } catch (e) {
    return { found: false };
  }
}

/**
 * Find Prisma schema file
 */
function findPrismaSchema(rootDir) {
  const commonPaths = [
    'prisma/schema.prisma',
    'apps/server/prisma/schema.prisma',
    'packages/server/prisma/schema.prisma',
    'backend/prisma/schema.prisma',
    'server/prisma/schema.prisma'
  ];
  
  for (const relativePath of commonPaths) {
    if (fs.existsSync(path.join(rootDir, relativePath))) {
      return relativePath;
    }
  }
  
  // Fallback: search
  try {
    const result = execSync(
      'find . -name "schema.prisma" -path "*/prisma/*" -maxdepth 5 ' +
      '-not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null || true',
      { encoding: 'utf8', cwd: rootDir, stdio: 'pipe' }
    ).trim();
    
    if (result) {
      return result.split('\n')[0].replace(/^\.\//, '');
    }
  } catch (e) {
    // Ignore
  }
  
  return null;
}

/**
 * Find Dockerfile
 */
function findDockerfile(rootDir) {
  const commonPaths = [
    'Dockerfile',
    'apps/server/Dockerfile',
    'packages/server/Dockerfile',
    'backend/Dockerfile',
    'server/Dockerfile'
  ];
  
  for (const relativePath of commonPaths) {
    if (fs.existsSync(path.join(rootDir, relativePath))) {
      return relativePath;
    }
  }
  
  return null;
}

/**
 * Detect package manager
 */
function detectPackageManager(rootDir) {
  if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) {
    return 'npm';
  }
  return 'npm'; // default
}

/**
 * Detect Node.js version from package.json
 */
function detectNodeVersion(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (pkg?.engines?.node) {
      // Handle ranges like ">=18.0.0" or "^20.0.0" or exact "24.11.1"
      // Extract the version number and keep major.minor or major.minor.patch
      const cleaned = pkg.engines.node.replace(/[^0-9.]/g, '');
      // Return the full version string (e.g., "24.11.1" or "20")
      return cleaned || null;
    }
  } catch (e) {
    // Ignore errors
  }
  
  return null;
}

/**
 * Detect pnpm version from package.json
 */
function detectPnpmVersion(rootDir) {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    // Check packageManager field (e.g., "pnpm@9.1.0")
    if (pkg?.packageManager?.startsWith('pnpm@')) {
      const version = pkg.packageManager.split('@')[1];
      // Return major version for compatibility
      return version.split('.')[0];
    }
    
    // Check engines.pnpm
    if (pkg?.engines?.pnpm) {
      const cleaned = pkg.engines.pnpm.replace(/[^0-9.]/g, '');
      // Return major version
      return cleaned.split('.')[0];
    }
  } catch (e) {
    // Ignore errors
  }
  
  return null;
}

/**
 * Generate factiiiAuto.yml with auto-detected values
 */
function generateCoreAuto(rootDir, options = {}) {
  const outputPath = path.join(rootDir, 'factiiiAuto.yml');
  
  console.log('🔍 Auto-detecting project configuration...\n');
  
  const hasNextJs = detectNextJs(rootDir);
  const hasExpo = detectExpo(rootDir);
  const hasTrpc = detectTrpc(rootDir);
  const prisma = detectPrisma(rootDir);
  const dockerfile = findDockerfile(rootDir);
  const packageManager = detectPackageManager(rootDir);
  const nodeVersion = detectNodeVersion(rootDir);
  const pnpmVersion = detectPnpmVersion(rootDir);
  
  // Get Factiii version for tracking
  const factiiiVersion = getFactiiiVersion();
  
  // Build config
  const lines = [
    '# Auto-detected configuration',
    '# Generated by: npx factiii init',
    '# To override values, add: value OVERRIDE newvalue',
    '',
    '# Factiii version tracking',
    `factiii_version: ${factiiiVersion}`,
    `factiii_min_version: ${factiiiVersion}`,
    ''
  ];
  
  // Stack detection
  lines.push('# Detected stack components');
  lines.push(`has_nextjs: ${hasNextJs}`);
  lines.push(`has_expo: ${hasExpo}`);
  lines.push(`has_trpc: ${hasTrpc}`);
  lines.push(`has_prisma: ${prisma.found}`);
  lines.push('');
  
  // Prisma config
  if (prisma.found) {
    lines.push('# Prisma configuration');
    if (prisma.schemaPath) {
      lines.push(`prisma_schema: ${prisma.schemaPath}`);
    }
    if (prisma.version) {
      lines.push(`prisma_version: ${prisma.version}`);
    }
    lines.push('');
  }
  
  // SSH configuration (defaults)
  lines.push('# SSH configuration');
  lines.push('# Default SSH user for all environments (override with: ubuntu OVERRIDE admin)');
  lines.push('ssh_user: ubuntu');
  lines.push('');
  
  // Build configuration
  lines.push('# Build configuration');
  if (dockerfile) {
    lines.push(`dockerfile: ${dockerfile}`);
  } else {
    lines.push('# dockerfile: Dockerfile  # Not found - you may need to create one');
  }
  lines.push(`package_manager: ${packageManager}`);
  
  // Runtime versions
  if (nodeVersion) {
    lines.push(`node_version: ${nodeVersion}`);
  }
  if (pnpmVersion && packageManager === 'pnpm') {
    lines.push(`pnpm_version: ${pnpmVersion}`);
  }
  
  lines.push('');
  
  const content = lines.join('\n');
  
  // Check if file exists and content changed
  const exists = fs.existsSync(outputPath);
  if (exists) {
    const existingContent = fs.readFileSync(outputPath, 'utf8');
    if (existingContent === content) {
      console.log('⏭️  factiiiAuto.yml unchanged');
      return;
    }
  }
  
  // Write file
  fs.writeFileSync(outputPath, content);
  
  if (exists) {
    console.log('🔄 Updated factiiiAuto.yml');
  } else {
    console.log('✅ Created factiiiAuto.yml');
  }
  
  // Display detected values
  console.log('\n📊 Detected configuration:');
  if (hasNextJs) console.log('   ✅ Next.js detected');
  if (hasExpo) console.log('   ✅ Expo detected');
  if (hasTrpc) console.log('   ✅ tRPC detected');
  if (prisma.found) {
    console.log('   ✅ Prisma detected');
    if (prisma.schemaPath) console.log(`      Schema: ${prisma.schemaPath}`);
    if (prisma.version) console.log(`      Version: ${prisma.version}`);
  }
  if (dockerfile) console.log(`   ✅ Dockerfile: ${dockerfile}`);
  console.log(`   📦 Package manager: ${packageManager}`);
  if (nodeVersion) console.log(`   📦 Node version: ${nodeVersion}`);
  if (pnpmVersion && packageManager === 'pnpm') console.log(`   📦 pnpm version: ${pnpmVersion}`);
  console.log('');
}

module.exports = { generateCoreAuto };

