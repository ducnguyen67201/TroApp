import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type { ReactElement } from 'react';
import '@mantine/core/styles.css';
import { ComputerUsePage } from '../../../../../src/desktop/renderer/ComputerUsePage.js';
import { useComputerUse } from '../../../../../src/desktop/renderer/UseComputerUse.js';
import { LocaleProvider } from '../../../../../src/desktop/renderer/localization/LocaleProvider.js';

/** Fixture controls call the same controller as the production form. No extra
 * renderer privileges or generic IPC are exposed by the contract. */
function TeachingFlowRenderer(): ReactElement {
  const controller = useComputerUse();
  const outcome = controller.messages.at(-1)?.outcome ?? '';
  return (
    <>
      <div
        id="contract-state"
        data-ready={!controller.isLoading && Boolean(controller.user)}
        data-sending={controller.isSending}
        data-phase={controller.teachingPhase ?? ''}
        data-outcome={outcome}
        data-step={controller.teachingStep ?? ''}
      />
      <button
        id="contract-start"
        disabled={controller.isLoading || controller.isSending}
        onClick={() => void controller.sendMessage('Open YouTube, contract goal.')}
      >
        Start contract
      </button>
      <button id="contract-answer" onClick={() => void controller.sendMessage('Chrome')}>
        Answer Chrome
      </button>
      <ComputerUsePage controller={controller} />
    </>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Teaching contract root is missing.');
}
createRoot(root).render(
  <MantineProvider>
    <LocaleProvider>
      <TeachingFlowRenderer />
    </LocaleProvider>
  </MantineProvider>,
);
