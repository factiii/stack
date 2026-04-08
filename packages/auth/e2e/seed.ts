import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5444/auth_test';

async function seed() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log('Seeding database...');

  const password = await bcrypt.hash('password123', 10);

  // Basic test user
  const testUser = await prisma.user.upsert({
    where: { email: 'test@example.com' },
    update: {},
    create: {
      username: 'testuser',
      email: 'test@example.com',
      password,
      status: 'ACTIVE',
      emailVerificationStatus: 'VERIFIED',
    },
  });
  console.log(`  Created user: testuser (id: ${testUser.id})`);

  // Admin user with a session
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      username: 'adminuser',
      email: 'admin@example.com',
      password,
      status: 'ACTIVE',
      emailVerificationStatus: 'VERIFIED',
    },
  });
  await prisma.session.create({
    data: {
      userId: adminUser.id,
      browserName: 'Chrome',
    },
  });
  console.log(`  Created user: adminuser (id: ${adminUser.id}) with session`);

  // 2FA user — starts without 2FA; the e2e two-factor specs enable it themselves.
  const twofaUser = await prisma.user.upsert({
    where: { email: 'twofa@example.com' },
    update: {},
    create: {
      username: 'twofa_user',
      email: 'twofa@example.com',
      password,
      status: 'ACTIVE',
      emailVerificationStatus: 'VERIFIED',
    },
  });
  console.log(`  Created user: twofa_user (id: ${twofaUser.id})`);

  console.log('\nSeed complete. Test credentials:');
  console.log('  All passwords: password123');
  console.log('  Users: testuser, adminuser, twofa_user');

  await prisma.$disconnect();
  await pool.end();
}

seed().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
