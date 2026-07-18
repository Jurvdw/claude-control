// Standalone seed entrypoint (`npm run db:seed`). The app also self-seeds on
// boot; this delegates to the canonical seeder shared by both.
import { prisma } from '../src/lib/prisma.js';
import { ensureSeed } from '../src/db/seed.js';

ensureSeed()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('Seeded agent templates.');
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
