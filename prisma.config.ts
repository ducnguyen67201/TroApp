import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { readPrismaEnv } from './prisma/Env.ts';

const environment = readPrismaEnv({
  ...process.env,
  DATABASE_URL:
    process.env['DATABASE_URL'] ?? 'postgresql://tro:local_demo_only@127.0.0.1:54329/tro',
});

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: environment.DATABASE_URL },
});
