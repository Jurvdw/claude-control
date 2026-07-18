import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env.js';

// Singleton Prisma client (avoids exhausting connections during dev hot-reload).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!isProd) globalForPrisma.prisma = prisma;
