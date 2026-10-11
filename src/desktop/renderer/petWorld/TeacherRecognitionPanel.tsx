import type { ReactElement } from 'react';
import { Stack } from '@mantine/core';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { PetWorldCommand, PetWorldReply } from '#contracts/PetWorld.js';
import { TeacherRecognitionForm } from './TeacherRecognitionForm.js';
import { RecognitionCoverage } from './RecognitionCoverage.js';
import { RecognitionHistory } from './RecognitionHistory.js';
import type { PetWorldTranslate } from './PetWorldLabels.js';

type RecognitionView = Extract<PetWorldReply, { kind: 'class-recognition' }>;

interface TeacherRecognitionPanelProps {
  userId: string;
  recognition: RecognitionView;
  isSaving: boolean;
  locale: DesktopLocale;
  t: PetWorldTranslate;
  sendCommand: (command: PetWorldCommand) => Promise<boolean>;
  readOlderRecognitions: () => Promise<void>;
}

/** Class recognition composes input, descriptive coverage and immutable award history. */
export function TeacherRecognitionPanel({
  userId,
  recognition,
  isSaving,
  locale,
  t,
  sendCommand,
  readOlderRecognitions,
}: TeacherRecognitionPanelProps): ReactElement {
  return (
    <Stack gap="lg">
      <TeacherRecognitionForm
        recognition={recognition}
        isSaving={isSaving}
        locale={locale}
        t={t}
        sendCommand={sendCommand}
      />
      <RecognitionCoverage recognition={recognition} t={t} />
      <RecognitionHistory
        userId={userId}
        recognition={recognition}
        isSaving={isSaving}
        locale={locale}
        t={t}
        sendCommand={sendCommand}
        readOlderRecognitions={readOlderRecognitions}
      />
    </Stack>
  );
}
