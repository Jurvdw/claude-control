import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:4000'),
  // Defaults to the bundled embedded Postgres — the app runs with no .env at all.
  DATABASE_URL: z
    .string()
    .default('postgresql://cc:cc@127.0.0.1:54329/claude_control?schema=public'),
  // When true, the app starts a local Postgres child process (no Docker/install).
  // Set false to point DATABASE_URL at an external Postgres instead.
  EMBEDDED_PG: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  // Where the embedded Postgres stores its data (relative to packages/server).
  PG_DATA_DIR: z.string().default('./data/pg'),
  // 32-byte key, base64. Falls back to a dev key (NOT for production; the
  // desktop app generates a unique per-install key — see electron/main.cjs).
  ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHktMzItYnl0ZS1lbmNyeXB0aW9uLWtleSE='),
  SESSION_SECRET: z.string().default('dev-session-secret-change-me'),
  LLM_PROVIDER_MODE: z.enum(['apikey', 'subscription']).default('apikey'),
  SELF_HOSTED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  ANTHROPIC_API_KEY: z.string().optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  // Where @xenova/transformers caches downloaded model weights (~90MB, once
  // per install). Must be writable — the library's own default (inside its
  // node_modules folder) lives inside the read-only app.asar in the packaged
  // desktop app, so this points it somewhere durable instead (see electron/main.cjs).
  EMBEDDING_CACHE_DIR: z.string().default('./data/embeddings-cache'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Prisma reads DATABASE_URL from process.env directly (via schema.prisma's
// env("DATABASE_URL")), not from our parsed object. Write the resolved value
// back so defaults apply even when there is no .env file (e.g. the packaged app).
process.env.DATABASE_URL = env.DATABASE_URL;

// Subscription mode is only permitted on self-hosted deployments.
export const subscriptionModeEnabled = env.LLM_PROVIDER_MODE === 'subscription' && env.SELF_HOSTED;

export const isProd = env.NODE_ENV === 'production';
