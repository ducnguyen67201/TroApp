import { z } from 'zod';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/server/generated/prisma/client.js';
import { readServerEnv } from '../src/server/Env.js';
import { readClassroomInsightConfig } from '../src/server/config/Index.js';
import { createPrismaClassroomInsightStore } from '../src/server/persistence/PrismaClassroomInsightStore.js';
import {
  importClassroomLearning,
  LearningImportStage,
} from '../src/server/persistence/ImportClassroomLearning.js';

/** Dry-run by default. Explicit --apply imports one class without inventing historical eligibility. */
async function backfillClassroomInsights() {
  const classId = z.uuid().parse(process.argv[2]);
  const apply = process.argv[3] === '--apply';
  const environment = readServerEnv(process.env);
  const insightConfig = readClassroomInsightConfig();
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  try {
    if (!apply) {
      const result = await importClassroomLearning(client, classId, false);
      console.info({ operation: 'classroom-insights-import', classId, apply, ...result });
      return;
    }
    const policyStore = createPrismaClassroomInsightStore(environment.DATABASE_URL, {
      captureClassIds: [classId],
      ...insightConfig,
    });
    try {
      let more: boolean;
      do {
        more = (await policyStore.purgeExpiredSources(new Date(), insightConfig.retentionDays))
          .more;
      } while (more);
    } finally {
      await policyStore.close();
    }
    // Each batch commits independently; rerunning safely resumes through source identities.
    for (const stage of Object.values(LearningImportStage)) {
      let cursor: string | undefined;
      do {
        const result = await client.$transaction(
          (transaction) =>
            importClassroomLearning(transaction, classId, true, {
              stage,
              limit: 200,
              ...(cursor ? { afterId: cursor } : {}),
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
        );
        console.info({ operation: 'classroom-insights-import', classId, apply, stage, ...result });
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
    }
  } finally {
    await client.$disconnect();
  }
}

await backfillClassroomInsights();
