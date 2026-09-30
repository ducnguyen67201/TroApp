import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/** Validates CLI configuration without printing credential-bearing values. */
export function readPrismaEnv(environment: NodeJS.ProcessEnv): { DATABASE_URL: string } {
  return createEnv({
    server: { DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//) },
    runtimeEnv: environment,
    onValidationError: () => {
      throw new Error('Prisma configuration is invalid.');
    },
  });
}
