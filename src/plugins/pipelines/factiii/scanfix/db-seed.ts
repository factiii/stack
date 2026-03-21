/**
 * Database Seeding Scanfix
 *
 * Detects whether the local dev database is running and seeded.
 * - No DB → auto-runs pnpm seed
 * - DB exists but empty → prompts user for seeding strategy
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import type { Fix, FactiiiConfig } from '../../../../types/index.js';

/**
 * Try to connect to the database via prisma
 * Returns: 'no-db' | 'empty' | 'seeded'
 */
function checkDbState(rootDir: string): 'no-db' | 'empty' | 'seeded' {
  try {
    execSync('npx prisma db execute --stdin', {
      input: 'SELECT 1',
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return 'no-db';
  }

  // DB is reachable — check if tables have rows
  try {
    const result = execSync('npx prisma db execute --stdin', {
      input: "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = result.toString();
    // If count is 0 or only prisma migration table, treat as empty
    const match = output.match(/(\d+)/);
    if (match && match[1] && parseInt(match[1], 10) <= 1) {
      return 'empty';
    }
  } catch {
    // If we can't query information_schema, treat as empty
    return 'empty';
  }

  return 'seeded';
}

/**
 * Prompt user with numbered options, returns the chosen number
 */
function promptChoice(question: string, options: string[]): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let prompt = '   ' + question + '\n';
  for (let i = 0; i < options.length; i++) {
    prompt += '   ' + (i + 1) + ') ' + options[i] + '\n';
  }
  prompt += '   Choose (1-' + options.length + '): ';

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      resolve(num >= 1 && num <= options.length ? num : 1);
    });
  });
}

/**
 * Find the DB container name from docker compose
 */
function findDbContainer(rootDir: string): string {
  try {
    const output = execSync('docker compose ps --format "{{.Name}}"', {
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const lines = output.trim().split('\n');
    const dbLine = lines.find((l) => /db|postgres|mysql/i.test(l));
    return dbLine ? dbLine.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Read DB credentials from .env file
 */
function readDbCreds(rootDir: string): { user: string; db: string } {
  const envPath = path.join(rootDir, '.env');
  let user = 'postgres';
  let db = 'postgres';
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const userMatch = content.match(/POSTGRES_USER=(.+)/);
    const dbMatch = content.match(/POSTGRES_DB=(.+)/);
    if (userMatch && userMatch[1]) user = userMatch[1].trim();
    if (dbMatch && dbMatch[1]) db = dbMatch[1].trim();
  } catch {
    // defaults
  }
  return { user, db };
}

export const dbSeedFixes: Fix[] = [
  {
    id: 'db-needs-seed',
    stage: 'dev',
    severity: 'warning',
    description: 'Database needs seeding',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Only relevant if project uses prisma
      if (!fs.existsSync(path.join(rootDir, 'prisma', 'schema.prisma'))) {
        return false;
      }
      const state = checkDbState(rootDir);
      return state === 'no-db' || state === 'empty';
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const state = checkDbState(rootDir);

      if (state === 'no-db') {
        // No DB running — just seed (prisma will push schema + seed)
        console.log('   No database detected. Running pnpm seed...');
        try {
          execSync('pnpm seed', { cwd: rootDir, stdio: 'inherit' });
          return true;
        } catch {
          console.log('   pnpm seed failed.');
          return false;
        }
      }

      // DB exists but empty — prompt user
      const hasInitSql = fs.existsSync(path.join(rootDir, 'init.sql'));
      const options = ['Do nothing', 'Reseed (drop + seed)'];
      if (hasInitSql) {
        options.push('Seed from init.sql');
      }

      const choice = await promptChoice('Database exists but appears empty.', options);

      if (choice === 1) {
        console.log('   Skipping seed.');
        return true;
      }

      if (choice === 2) {
        console.log('   Running prisma migrate reset + seed...');
        try {
          execSync('npx prisma migrate reset --force', { cwd: rootDir, stdio: 'inherit' });
          return true;
        } catch {
          console.log('   Reseed failed.');
          return false;
        }
      }

      if (choice === 3 && hasInitSql) {
        const container = findDbContainer(rootDir);
        if (!container) {
          console.log('   Could not find DB container. Run: docker compose up -d');
          return false;
        }
        const { user, db } = readDbCreds(rootDir);
        const initSqlPath = path.join(rootDir, 'init.sql');
        console.log('   Injecting init.sql into ' + container + '...');
        try {
          const sql = fs.readFileSync(initSqlPath, 'utf-8');
          execSync('docker exec -i ' + container + ' psql -U ' + user + ' -d ' + db, {
            input: sql,
            cwd: rootDir,
            stdio: ['pipe', 'inherit', 'inherit'],
          });
          return true;
        } catch {
          console.log('   init.sql injection failed.');
          return false;
        }
      }

      return false;
    },
    manualFix: 'Run: pnpm seed',
  },
];
