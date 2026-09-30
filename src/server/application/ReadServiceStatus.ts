import { DatabaseAvailability, type SystemStatus } from '#contracts/SystemStatus.js';
import type { DatabaseStatus } from '../ports/DatabaseStatus.js';

export async function readServiceStatus(database: DatabaseStatus): Promise<SystemStatus> {
  const isReady = await database.isDatabaseReady();

  return {
    service: 'tro-api',
    database: isReady ? DatabaseAvailability.READY : DatabaseAvailability.UNAVAILABLE,
  };
}
