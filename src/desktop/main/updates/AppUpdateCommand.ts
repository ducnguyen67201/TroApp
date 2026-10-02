import {
  AppUpdateCommand,
  AppUpdateCommandSchema,
  AppUpdateFailure,
  type AppUpdateReply,
} from '#contracts/AppUpdate.js';
import type { AppUpdateController } from './AppUpdateController.js';

/** The trusted main frame can request only named actions, never update URLs. */
export async function runAppUpdateCommand(
  controller: AppUpdateController,
  rawCommand: unknown,
  isTrusted: boolean,
): Promise<AppUpdateReply> {
  const parsed = AppUpdateCommandSchema.safeParse(rawCommand);
  if (!isTrusted || !parsed.success) {
    return { kind: 'failed', reason: AppUpdateFailure.UNAVAILABLE };
  }
  switch (parsed.data.kind) {
    case AppUpdateCommand.STATUS:
      return { kind: 'ok', snapshot: controller.readStatus() };
    case AppUpdateCommand.CHECK:
      return controller.checkForUpdates();
    case AppUpdateCommand.DOWNLOAD:
      return controller.downloadUpdate();
    case AppUpdateCommand.RESTART:
      return controller.restartForUpdate();
  }
}
