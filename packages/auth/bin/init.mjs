#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default to the standard (user-centric TOTP) schema, which matches the
// default `twoFaMode: 'standard'`. Consumers running the legacy device flow
// should copy prisma/schema.device.prisma manually instead.
const schemaSource = join(__dirname, '..', 'prisma', 'schema.standard.prisma');
const targetDir = resolve(process.cwd(), 'prisma');
const targetFile = join(targetDir, 'auth-schema.prisma');

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
@factiii/auth CLI

Usage:
  npx @factiii/auth <command> [--prisma | --drizzle]

Commands:
  init     Generate the auth schema for your ORM (auto-detected)
  schema   Print the schema path (for manual copying)
  doctor   Check your project setup for common issues
  help     Show this help message

Flags:
  --prisma   Force Prisma mode (skip auto-detection)
  --drizzle  Force Drizzle mode (skip auto-detection)

Examples:
  npx @factiii/auth init            # auto-detects your ORM
  npx @factiii/auth init --drizzle  # force Drizzle schema
  npx @factiii/auth doctor
`);
}

/**
 * Read package.json deps and detect ORM.
 * Returns 'prisma' | 'drizzle' | 'both' | 'none'.
 */
function detectORMFromPackageJson() {
  const packageJsonPath = resolve(process.cwd(), 'package.json');
  if (!existsSync(packageJsonPath)) return 'none';
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return detectORM(deps);
  } catch {
    return 'none';
  }
}

/**
 * Resolve which ORM to use for init, considering CLI flags and auto-detection.
 */
function resolveORMForInit() {
  if (args.includes('--prisma')) return 'prisma';
  if (args.includes('--drizzle')) return 'drizzle';

  const detected = detectORMFromPackageJson();

  if (detected === 'both') {
    console.log('Both @prisma/client and drizzle-orm detected.');
    console.log('Use --prisma or --drizzle to specify which schema to generate:');
    console.log('  npx @factiii/auth init --prisma');
    console.log('  npx @factiii/auth init --drizzle');
    process.exit(1);
  }

  if (detected === 'none') {
    console.log('No ORM detected in package.json.');
    console.log('Install one first, or use a flag to force:');
    console.log('  npm install @prisma/client prisma   # then: npx @factiii/auth init');
    console.log('  npm install drizzle-orm              # then: npx @factiii/auth init');
    console.log('  npx @factiii/auth init --prisma      # force without installing first');
    console.log('  npx @factiii/auth init --drizzle     # force without installing first');
    process.exit(1);
  }

  return detected; // 'prisma' or 'drizzle'
}

// ── Drizzle schema template ─────────────────────────────────────────────────

const DRIZZLE_SCHEMA_TEMPLATE = `import { pgTable, pgEnum, serial, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Standard 2FA mode (the default). The TOTP secret + backup codes live on
// the user; 2FA is "on" iff \`twoFaSecret\` is non-null. No \`Device\` table,
// no per-session 2FA columns. If you need the legacy device/push-token
// flow, see prisma/schema.device.prisma in @factiii/auth.

// ==============================================================================
// Enums
// ==============================================================================

export const userStatusEnum = pgEnum('UserStatus', ['ACTIVE', 'DEACTIVATED', 'BANNED']);
export const userTagEnum = pgEnum('UserTag', ['HUMAN', 'BOT']);
export const emailVerificationStatusEnum = pgEnum('EmailVerificationStatus', ['UNVERIFIED', 'PENDING', 'VERIFIED']);
export const oauthProviderEnum = pgEnum('OAuthProvider', ['GOOGLE', 'APPLE']);

// ==============================================================================
// Users
// ==============================================================================

export const users = pgTable('User', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  status: userStatusEnum('status').default('ACTIVE').notNull(),
  email: text('email').unique().notNull(),
  emailVerificationStatus: emailVerificationStatusEnum('emailVerificationStatus').default('UNVERIFIED').notNull(),
  password: text('password'),
  username: text('username').unique().notNull(),
  twoFaSecret: text('twoFaSecret'),
  twoFaBackupCodes: text('twoFaBackupCodes').array().default([]).notNull(),
  oauthProvider: oauthProviderEnum('oauthProvider'),
  oauthId: text('oauthId'),
  tag: userTagEnum('tag').default('HUMAN').notNull(),
  isActive: boolean('isActive').default(false).notNull(),
  verifiedHumanAt: timestamp('verifiedHumanAt'),
  otpForEmailVerification: text('otpForEmailVerification'),
});

// ==============================================================================
// Sessions
// ==============================================================================

export const sessions = pgTable('Session', {
  id: serial('id').primaryKey(),
  socketId: text('socketId').unique(),
  issuedAt: timestamp('issuedAt').defaultNow().notNull(),
  browserName: text('browserName').default('Unknown').notNull(),
  lastUsed: timestamp('lastUsed').defaultNow().notNull(),
  userId: integer('userId').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  revokedAt: timestamp('revokedAt'),
});

// ==============================================================================
// Admins
// ==============================================================================

export const admins = pgTable('Admin', {
  userId: integer('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  ip: text('ip').notNull(),
});

// ==============================================================================
// Password Resets
// ==============================================================================

export const passwordResets = pgTable('PasswordReset', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  userId: integer('userId').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  invalidatedAt: timestamp('invalidatedAt'),
});

// ==============================================================================
// OTPs
// ==============================================================================

export const otps = pgTable('OTP', {
  id: serial('id').primaryKey(),
  code: integer('code').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  userId: integer('userId').references(() => users.id, { onDelete: 'cascade' }).notNull(),
});

// ==============================================================================
// Relations
// ==============================================================================

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  passwordResets: many(passwordResets),
  otps: many(otps),
  admin: one(admins),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const adminsRelations = relations(admins, ({ one }) => ({
  user: one(users, { fields: [admins.userId], references: [users.id] }),
}));

export const passwordResetsRelations = relations(passwordResets, ({ one }) => ({
  user: one(users, { fields: [passwordResets.userId], references: [users.id] }),
}));

export const otpsRelations = relations(otps, ({ one }) => ({
  user: one(users, { fields: [otps.userId], references: [users.id] }),
}));
`;

// ── Init commands ───────────────────────────────────────────────────────────

function initPrisma() {
  // Ensure prisma directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    console.log('Created prisma/ directory');
  }

  // Check if file already exists
  if (existsSync(targetFile)) {
    console.log(`⚠️  ${targetFile} already exists`);
    console.log('   To overwrite, delete it first and run again.');
    process.exit(1);
  }

  // Copy schema
  try {
    copyFileSync(schemaSource, targetFile);
    console.log(`✓ Copied Prisma schema to ${targetFile}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review and customize the schema for your database provider');
    console.log('  2. Merge models into your existing schema.prisma (if you have one)');
    console.log('  3. Run: npx prisma generate');
    console.log('  4. Run: npx prisma db push (or prisma migrate dev)');
  } catch (err) {
    console.error('Failed to copy schema:', err.message);
    process.exit(1);
  }
}

function initDrizzle() {
  // Determine target location
  const candidates = [
    { dir: 'src/db', file: 'src/db/auth-schema.ts' },
    { dir: 'drizzle', file: 'drizzle/auth-schema.ts' },
  ];

  // Pick the first directory that already exists, or default to src/db
  let target = candidates[0];
  for (const c of candidates) {
    if (existsSync(resolve(process.cwd(), c.dir))) {
      target = c;
      break;
    }
  }

  const targetDirDrizzle = resolve(process.cwd(), target.dir);
  const targetFileDrizzle = resolve(process.cwd(), target.file);

  // Ensure directory exists
  if (!existsSync(targetDirDrizzle)) {
    mkdirSync(targetDirDrizzle, { recursive: true });
    console.log(`Created ${target.dir}/ directory`);
  }

  // Check if file already exists
  if (existsSync(targetFileDrizzle)) {
    console.log(`⚠️  ${target.file} already exists`);
    console.log('   To overwrite, delete it first and run again.');
    process.exit(1);
  }

  try {
    writeFileSync(targetFileDrizzle, DRIZZLE_SCHEMA_TEMPLATE);
    console.log(`✓ Generated Drizzle schema at ${target.file}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review and customize the schema (table names, column types, etc.)');
    console.log('  2. Import and merge into your existing schema (if you have one)');
    console.log('  3. Create a drizzle.config.ts if you haven\'t already');
    console.log('  4. Run: npx drizzle-kit generate');
    console.log('  5. Run: npx drizzle-kit migrate');
    console.log('');
    console.log('Usage with @factiii/auth:');
    console.log('  import { createDrizzleAdapter } from \'@factiii/auth\';');
    console.log(`  import * as schema from './${target.file.replace(/\.ts$/, '')}';`);
    console.log('  const adapter = createDrizzleAdapter(db, {');
    console.log('    users: schema.users,');
    console.log('    sessions: schema.sessions,');
    console.log('    otps: schema.otps,');
    console.log('    passwordResets: schema.passwordResets,');
    console.log('    admins: schema.admins,');
    console.log('  });');
  } catch (err) {
    console.error('Failed to generate schema:', err.message);
    process.exit(1);
  }
}

function init() {
  const orm = resolveORMForInit();
  console.log(`Detected ORM: ${orm}\n`);

  if (orm === 'prisma') {
    initPrisma();
  } else if (orm === 'drizzle') {
    initDrizzle();
  }
}

function printSchemaPath() {
  const orm = resolveORMForInit();

  if (orm === 'prisma') {
    console.log('Prisma schema location:');
    console.log(`  ${schemaSource}`);
    console.log('');
    console.log('Copy manually:');
    console.log(`  cp "${schemaSource}" ./prisma/auth-schema.prisma`);
  } else if (orm === 'drizzle') {
    console.log('Drizzle schema:');
    console.log('  Run: npx @factiii/auth init --drizzle');
    console.log('  This generates a TypeScript schema file with all required tables.');
  }
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

const ok = (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`);
const fail = (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`);
const warn = (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`);
const hint = (msg) => console.log(`${colors.dim}  ${msg}${colors.reset}`);

/**
 * Recursively find all .prisma files in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} files - Accumulator for found files
 * @returns {string[]} Array of file paths
 */
function findPrismaFiles(dir, files = []) {
  if (!existsSync(dir)) return files;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'migrations') {
        findPrismaFiles(fullPath, files);
      } else if (entry.isFile() && entry.name.endsWith('.prisma')) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory read failed
  }

  return files;
}

/**
 * Find and read all Prisma schema files (supports single file and modularized schemas)
 * Patterns supported:
 *   - prisma/schema.prisma (single file)
 *   - prisma/schema/*.prisma (modularized in schema dir)
 *   - prisma/schema.prisma + prisma/models/*.prisma (hybrid)
 *   - prisma/*.prisma (multiple files in prisma dir)
 * @returns {{ found: boolean, schemaContent: string, location: string }}
 */
function findPrismaSchema() {
  const prismaDir = resolve(process.cwd(), 'prisma');

  if (!existsSync(prismaDir)) {
    return { found: false, schemaContent: '', location: '' };
  }

  // Find all .prisma files recursively (excluding migrations)
  const allFiles = findPrismaFiles(prismaDir);

  if (allFiles.length === 0) {
    return { found: false, schemaContent: '', location: '' };
  }

  // Read and combine all schema files
  const combinedSchema = allFiles
    .map(f => readFileSync(f, 'utf-8'))
    .join('\n');

  // Build location description
  let location;
  if (allFiles.length === 1 && allFiles[0] === join(prismaDir, 'schema.prisma')) {
    location = 'prisma/schema.prisma';
  } else {
    // Get unique directories
    const dirs = [...new Set(allFiles.map(f => dirname(f).replace(prismaDir, 'prisma')))];
    location = `${dirs.join(', ')} (${allFiles.length} files)`;
  }

  return {
    found: true,
    schemaContent: combinedSchema,
    location
  };
}

function parseReferenceSchema() {
  const schema = readFileSync(schemaSource, 'utf-8');

  // Extract model names
  const models = [...schema.matchAll(/model\s+(\w+)\s*\{/g)].map(m => m[1]);

  // Extract enum names
  const enums = [...schema.matchAll(/enum\s+(\w+)\s*\{/g)].map(m => m[1]);

  // Extract fields for each model
  const modelFields = {};
  for (const model of models) {
    const modelMatch = schema.match(new RegExp(`model\\s+${model}\\s*\\{([^}]+)\\}`, 'm'));
    if (modelMatch) {
      const block = modelMatch[1];
      // Match field names (first word on lines that aren't comments or @@)
      const fields = [...block.matchAll(/^\s*(\w+)\s+\w+/gm)]
        .map(m => m[1])
        .filter(f => !f.startsWith('@@'));
      modelFields[model] = fields;
    }
  }

  return { models, enums, modelFields };
}

/**
 * Detect which ORM the consumer's project uses.
 * Returns 'prisma' | 'drizzle' | 'both' | 'none'.
 */
function detectORM(deps) {
  const hasPrisma = Boolean(deps['@prisma/client']);
  const hasDrizzle = Boolean(deps['drizzle-orm']);
  if (hasPrisma && hasDrizzle) return 'both';
  if (hasPrisma) return 'prisma';
  if (hasDrizzle) return 'drizzle';
  return 'none';
}

/**
 * Look for Drizzle schema files (*.ts files exporting table definitions).
 * Common patterns: src/db/schema.ts, drizzle/schema.ts, src/schema.ts
 */
function findDrizzleSchema() {
  const candidates = [
    'src/db/schema.ts',
    'src/db/schema/index.ts',
    'src/schema.ts',
    'drizzle/schema.ts',
    'db/schema.ts',
    'src/db/schema.js',
    'drizzle/schema.js',
  ];

  for (const candidate of candidates) {
    const fullPath = resolve(process.cwd(), candidate);
    if (existsSync(fullPath)) {
      return { found: true, location: candidate };
    }
  }
  return { found: false, location: '' };
}

/**
 * Check for drizzle config file (drizzle.config.ts or drizzle.config.js)
 */
function findDrizzleConfig() {
  const candidates = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs'];
  for (const candidate of candidates) {
    if (existsSync(resolve(process.cwd(), candidate))) {
      return { found: true, location: candidate };
    }
  }
  return { found: false, location: '' };
}

function doctor() {
  console.log(`${colors.bold}${colors.cyan}Running diagnostics...${colors.reset}\n`);

  let issues = 0;
  let warnings = 0;

  // Parse reference schema to get required models/enums/fields
  let reference;
  try {
    reference = parseReferenceSchema();
  } catch (e) {
    fail('Could not read reference schema from package');
    process.exit(1);
  }

  // Check 1: package.json exists and detect ORM
  const packageJsonPath = resolve(process.cwd(), 'package.json');
  let orm = 'none';

  if (!existsSync(packageJsonPath)) {
    fail('No package.json found in current directory');
    issues++;
  } else {
    ok('package.json found');

    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      orm = detectORM(deps);

      switch (orm) {
        case 'prisma':
          ok('@prisma/client found — using Prisma adapter');
          break;
        case 'drizzle':
          ok('drizzle-orm found — using Drizzle adapter');
          break;
        case 'both':
          ok('@prisma/client and drizzle-orm both found');
          hint('You can use either createPrismaAdapter() or createDrizzleAdapter()');
          break;
        case 'none':
          fail('No ORM detected — install @prisma/client or drizzle-orm');
          hint('Prisma:  npm install @prisma/client prisma');
          hint('Drizzle: npm install drizzle-orm');
          issues++;
          break;
      }
    } catch (e) {
      warn('Could not parse package.json');
      warnings++;
    }
  }

  // Check 2: ORM-specific schema checks
  if (orm === 'prisma' || orm === 'both') {
    console.log(`\n${colors.bold}Prisma checks:${colors.reset}`);

    const { found: schemaFound, schemaContent: schema, location: schemaLocation } = findPrismaSchema();
    if (!schemaFound) {
      fail('No Prisma schema found');
      hint('Checked: prisma/schema.prisma, prisma/schema/*.prisma, prisma/*.prisma');
      hint('Run: npx @factiii/auth init');
      issues++;
    } else {
      ok(`Prisma schema found (${schemaLocation})`);

      try {
        // Check models
        for (const model of reference.models) {
          const regex = new RegExp(`model\\s+${model}\\s*\\{`, 'm');
          if (regex.test(schema)) {
            ok(`Model ${colors.cyan}${model}${colors.reset} found`);
          } else {
            fail(`Model ${colors.cyan}${model}${colors.reset} not found in schema`);
            issues++;
          }
        }

        // Check enums
        for (const enumName of reference.enums) {
          const regex = new RegExp(`enum\\s+${enumName}\\s*\\{`, 'm');
          if (regex.test(schema)) {
            ok(`Enum ${colors.cyan}${enumName}${colors.reset} found`);
          } else {
            fail(`Enum ${colors.cyan}${enumName}${colors.reset} not found in schema`);
            issues++;
          }
        }

        // Check fields for each model
        for (const [model, fields] of Object.entries(reference.modelFields)) {
          const modelMatch = schema.match(new RegExp(`model\\s+${model}\\s*\\{([^}]+)\\}`, 'm'));
          if (modelMatch) {
            const block = modelMatch[1];
            for (const field of fields) {
              const fieldRegex = new RegExp(`\\b${field}\\b`, 'm');
              if (!fieldRegex.test(block)) {
                warn(`${model}.${colors.cyan}${field}${colors.reset} field not found`);
                warnings++;
              }
            }
          }
        }
      } catch (e) {
        warn('Could not parse Prisma schema');
        warnings++;
      }
    }
  }

  if (orm === 'drizzle' || orm === 'both') {
    console.log(`\n${colors.bold}Drizzle checks:${colors.reset}`);

    const drizzleConfig = findDrizzleConfig();
    if (drizzleConfig.found) {
      ok(`Drizzle config found (${drizzleConfig.location})`);
    } else {
      warn('No drizzle.config.ts found (optional but recommended for migrations)');
      warnings++;
    }

    const drizzleSchema = findDrizzleSchema();
    if (drizzleSchema.found) {
      ok(`Drizzle schema found (${drizzleSchema.location})`);
    } else {
      warn('No Drizzle schema file found');
      hint('Expected in: src/db/schema.ts, drizzle/schema.ts, or src/schema.ts');
      hint('See SETUP.md for required table definitions');
      warnings++;
    }

    // Check that required tables are referenced (basic text scan of schema file)
    if (drizzleSchema.found) {
      try {
        const schemaContent = readFileSync(resolve(process.cwd(), drizzleSchema.location), 'utf-8');
        const requiredTables = ['users', 'sessions', 'admins', 'passwordResets', 'otps'];
        for (const table of requiredTables) {
          // Look for pgTable/mysqlTable/sqliteTable calls or export names
          const tableRegex = new RegExp(`(?:Table|export).*${table}`, 'i');
          if (tableRegex.test(schemaContent)) {
            ok(`Table ${colors.cyan}${table}${colors.reset} found`);
          } else {
            warn(`Table ${colors.cyan}${table}${colors.reset} not found in schema`);
            hint(`createDrizzleAdapter() expects a '${table}' table reference`);
            warnings++;
          }
        }
      } catch (e) {
        warn('Could not read Drizzle schema file');
        warnings++;
      }
    }
  }

  // Summary
  console.log(`\n${colors.bold}--- Summary ---${colors.reset}`);
  if (issues === 0 && warnings === 0) {
    console.log(`${colors.green}${colors.bold}All checks passed!${colors.reset} Your setup looks good.`);
  } else {
    if (issues > 0) {
      console.log(`${colors.red}${colors.bold}${issues} issue(s) found${colors.reset}`);
    }
    if (warnings > 0) {
      console.log(`${colors.yellow}${colors.bold}${warnings} warning(s) found${colors.reset}`);
    }
  }

  process.exit(issues > 0 ? 1 : 0);
}

switch (command) {
  case 'init':
    init();
    break;
  case 'schema':
    printSchemaPath();
    break;
  case 'doctor':
    doctor();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
