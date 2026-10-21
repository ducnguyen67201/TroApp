export const EvaluationApplication = {
  CONTROLLED: 'controlled',
  SCRATCH: 'scratch',
  VSCODE: 'vscode',
} as const;

export type EvaluationApplication =
  (typeof EvaluationApplication)[keyof typeof EvaluationApplication];
