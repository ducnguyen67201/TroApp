import { Menu, MenuItem, dialog, shell } from 'electron';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { selectEvaluationScenario } from './SelectEvaluationScenario.js';
import {
  SignedInEvaluationFailure,
  SignedInEvaluationApplication,
  type SignedInEvaluationResult,
} from './RunSignedInEvaluation.js';

interface EvaluationMenuOptions {
  canStart(): boolean;
  canNotify(): boolean;
  suspendFollowing(): Promise<void>;
  resumeFollowing(): Promise<void>;
  run(
    application: SignedInEvaluationApplication,
    taskMode: AgentTaskMode,
    signal: AbortSignal,
    scenarioFile?: string,
  ): Promise<SignedInEvaluationResult>;
}

export interface EvaluationMenu {
  isRunning(): boolean;
  stop(): Promise<void>;
}

/** Development-only native action. The renderer receives no credential, command,
 * path selection or generic IPC capability. Main owns admission and cancellation. */
export function registerEvaluationMenu(options: EvaluationMenuOptions): EvaluationMenu {
  let controller: AbortController | null = null;
  let execution: Promise<SignedInEvaluationResult> | null = null;
  const scenarios = [
    {
      application: SignedInEvaluationApplication.VSCODE,
      taskMode: AgentTaskMode.EXECUTE,
      label: 'Run automatic Python debugging evaluation (internal)',
    },
    {
      application: SignedInEvaluationApplication.VSCODE,
      taskMode: AgentTaskMode.TEACH,
      label: 'Run student Python debugging evaluation in VS Code',
    },
    {
      application: SignedInEvaluationApplication.SCRATCH,
      taskMode: AgentTaskMode.TEACH,
      label: 'Run Scratch teaching evaluation on this Mac',
    },
  ];
  let runItems: MenuItem[] = [];
  const startEvaluation = (
    application: SignedInEvaluationApplication,
    taskMode: AgentTaskMode,
    scenarioFile?: string,
  ): void => {
    if (controller || !options.canStart()) {
      void dialog.showMessageBox({
        message: 'Finish the current task or account change before running the evaluation.',
      });
      return;
    }
    const current = new AbortController();
    controller = current;
    for (const item of runItems) {
      item.enabled = false;
    }
    execution = (async () => {
      await options.suspendFollowing();
      current.signal.throwIfAborted();
      return options.run(application, taskMode, current.signal, scenarioFile);
    })();
    void execution
      .then(async (result) => {
        if (current.signal.aborted || !options.canNotify()) {
          return;
        }
        const response = await dialog.showMessageBox({
          message:
            result.exitCode === 0 ? 'Evaluation finished' : 'Evaluation stopped before completion',
          detail: `The recorded outputs and checklist are in:\n${result.outputDirectory}`,
          buttons: ['Show report folder', 'Close'],
        });
        if (response.response === 0 && options.canNotify()) {
          await shell.openPath(result.outputDirectory);
        }
      })
      .catch((error: unknown) => {
        if (!current.signal.aborted && options.canNotify()) {
          const requiresSignIn =
            error instanceof Error && error.message === SignedInEvaluationFailure.SIGN_IN_REQUIRED;
          void dialog.showMessageBox({
            message: requiresSignIn
              ? 'Sign in to Tro, then run the evaluation again.'
              : 'Could not start the evaluation. Check the gateway and desktop setup.',
          });
        }
      })
      .finally(async () => {
        controller = null;
        execution = null;
        for (const item of runItems) {
          item.enabled = true;
        }
        if (options.canNotify()) {
          await options.resumeFollowing().catch(() => {});
        }
      });
  };
  runItems = scenarios.map(
    (scenario) =>
      new MenuItem({
        label: scenario.label,
        click: () => {
          startEvaluation(scenario.application, scenario.taskMode);
        },
      }),
  );
  runItems.push(
    new MenuItem({
      label: 'Run scenario file automatically (internal)',
      click: () => {
        if (controller || !options.canStart()) {
          return;
        }
        void selectEvaluationScenario()
          .then((selected) => {
            if (selected && options.canNotify()) {
              startEvaluation(selected.application, AgentTaskMode.EXECUTE, selected.scenarioFile);
            }
          })
          .catch(() => {
            if (options.canNotify()) {
              void dialog.showMessageBox({
                message: 'Choose a generated Scenario.json for Python or Scratch.',
              });
            }
          });
      },
    }),
  );
  const menu =
    Menu.getApplicationMenu() ??
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]);
  const developmentMenu = new Menu();
  for (const item of runItems) {
    developmentMenu.append(item);
  }
  menu.append(new MenuItem({ label: 'Development', submenu: developmentMenu }));
  Menu.setApplicationMenu(menu);
  return {
    isRunning: () => controller !== null,
    stop: async () => {
      controller?.abort();
      await execution?.then(
        () => {},
        () => {},
      );
    },
  };
}
