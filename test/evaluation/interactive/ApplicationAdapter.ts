import { EvaluationApplication } from './EvaluationApplication.js';
import { EvaluationScenarioSchema, type EvaluationScenario } from './EvaluationScenario.js';
import type { WorkspaceOutcomeGrade, WorkspaceState } from './InteractiveStudyWorkspace.js';
import { ScratchWorkspace, type ScratchBrowserWindow } from './ScratchWorkspace.js';
import {
  VisualStudioCodeWorkspace,
  type VisualStudioCodePorts,
} from './VisualStudioCodeWorkspace.js';

export const ApplicationAdapterFailure = {
  SCENARIO_MISMATCH: 'evaluation_application_scenario_mismatch',
} as const;

/** An owned native target is readiness input, not evidence that pixels rendered. */
export interface ApplicationNativeTarget {
  processId: number;
  title: string;
  documentName: string;
}

/** Internal application boundary. Setup and finalization use reviewed adapters;
 * scenario data never supplies commands, JavaScript or executable grader paths. */
export interface ApplicationAdapter {
  readonly application: EvaluationScenario['application'];
  prepare(scenario: EvaluationScenario, trialId: string): Promise<void>;
  observe(): Promise<WorkspaceState>;
  finalize(): Promise<void>;
  grade(state: WorkspaceState, trialId: string): WorkspaceOutcomeGrade;
  supportsOutcome(): boolean;
  getNativeTarget(): ApplicationNativeTarget | null;
  close(): Promise<void>;
}

interface ApplicationWorkspace {
  reset(trialId: string, scenario?: EvaluationScenario): Promise<void>;
  readState(): Promise<WorkspaceState>;
  gradeState(state: WorkspaceState, trialId: string): WorkspaceOutcomeGrade;
  isOutcomeApplicable(): boolean;
  close(): Promise<void>;
}

interface PythonApplicationWorkspace extends ApplicationWorkspace {
  saveOutcome(): Promise<void>;
  getNativeTarget(): ApplicationNativeTarget | null;
}

interface ScratchApplicationWorkspace extends ApplicationWorkspace {
  exportProject(): Promise<void>;
}

export type ApplicationAdapterOptions =
  | {
      application: typeof EvaluationApplication.VSCODE;
      root: string;
      signal?: AbortSignal;
      visualStudioCodePorts?: VisualStudioCodePorts;
    }
  | {
      application: typeof EvaluationApplication.SCRATCH;
      root: string;
      window: ScratchBrowserWindow;
      signal?: AbortSignal;
    };

/** Narrow constructor ports let unit tests exercise the shared lifecycle without
 * launching a GUI. The runner selects only these fixed registered applications. */
export interface ApplicationAdapterFactories {
  createPythonWorkspace(
    root: string,
    signal?: AbortSignal,
    ports?: VisualStudioCodePorts,
  ): PythonApplicationWorkspace;
  createScratchWorkspace(
    window: ScratchBrowserWindow,
    root: string,
    signal?: AbortSignal,
  ): ScratchApplicationWorkspace;
}

function createWorkspaceAdapter(
  application: EvaluationScenario['application'],
  workspace: ApplicationWorkspace,
  finalize: () => Promise<void>,
  getNativeTarget: () => ApplicationNativeTarget | null,
): ApplicationAdapter {
  return {
    application,
    prepare: async (input, trialId) => {
      const scenario = EvaluationScenarioSchema.parse(input);
      if (scenario.application !== application) {
        throw new Error(ApplicationAdapterFailure.SCENARIO_MISMATCH);
      }
      await workspace.reset(trialId, scenario);
    },
    observe: () => workspace.readState(),
    finalize,
    grade: (state, trialId) => workspace.gradeState(state, trialId),
    supportsOutcome: () => workspace.isOutcomeApplicable(),
    getNativeTarget,
    close: () => workspace.close(),
  };
}

export function createApplicationAdapter(
  options: ApplicationAdapterOptions,
  factories: ApplicationAdapterFactories = {
    createPythonWorkspace: (root, signal, ports) =>
      new VisualStudioCodeWorkspace(root, signal, ports),
    createScratchWorkspace: (window, root, signal) => new ScratchWorkspace(window, root, signal),
  },
): ApplicationAdapter {
  if (options.application === EvaluationApplication.VSCODE) {
    const workspace = factories.createPythonWorkspace(
      options.root,
      options.signal,
      options.visualStudioCodePorts,
    );
    return createWorkspaceAdapter(
      options.application,
      workspace,
      () => workspace.saveOutcome(),
      () => workspace.getNativeTarget(),
    );
  }
  const workspace = factories.createScratchWorkspace(options.window, options.root, options.signal);
  return createWorkspaceAdapter(
    options.application,
    workspace,
    () => workspace.exportProject(),
    () => null,
  );
}
