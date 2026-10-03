import { z } from 'zod';

export const CuaCompanionBuild = {
  VERSION: '0.30.4-tro.14',
  SOURCE_COMMIT: 'bf6c76786d938070f4ecf1e44004752f69f518b8',
} as const;

/** Build provenance for the private companion-enabled native dependency. */
export const CuaCompanionBuildSchema = z.strictObject({
  version: z.literal(CuaCompanionBuild.VERSION),
  sourceCommit: z.literal(CuaCompanionBuild.SOURCE_COMMIT),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  architecture: z.enum(['arm64', 'x64']),
});
