import ts from 'typescript';
import {
  LessonVisualRenderFailure,
  LessonVisualRenderLimits,
  type LessonRenderFailure,
} from '../contracts/LessonRenderProtocol.js';

export type LessonVisualCodeFailure = Extract<LessonRenderFailure, { kind: 'code-error' }>;

/** Expected guest failures are distinct from worker/browser/infrastructure failures. */
export class LessonVisualCodeError extends Error {
  public readonly failure: LessonVisualCodeFailure;

  public constructor(code: LessonVisualCodeFailure['code'], diagnostic: string) {
    const bounded = (diagnostic.trim() || 'The scene could not execute.').slice(
      0,
      LessonVisualRenderLimits.DIAGNOSTIC_CHARACTERS,
    );
    super(bounded);
    this.name = 'LessonVisualCodeError';
    this.failure = { kind: 'code-error', code, diagnostic: bounded };
  }
}

/** Compile data with fixed tooling. Generated build scripts and dependencies never run. */
export function compileLessonVisual(source: string): string {
  if (source.length > LessonVisualRenderLimits.SOURCE_CHARACTERS) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.LIMIT,
      'The scene source is too large.',
    );
  }
  const syntax = ts.createSourceFile(
    'Scene.tsx',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  checkImports(syntax);
  const result = ts.transpileModule(source, {
    fileName: 'Scene.tsx',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'React.createElement',
      jsxFragmentFactory: 'React.Fragment',
      esModuleInterop: false,
      sourceMap: false,
    },
  });
  const failure = result.diagnostics?.find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (failure) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.COMPILE,
      ts.flattenDiagnosticMessageText(failure.messageText, '\n'),
    );
  }
  return result.outputText;
}

function checkImports(node: ts.Node): void {
  if (ts.isImportDeclaration(node)) {
    const name = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
    if (name !== 'react' && name !== 'remotion') {
      throw new LessonVisualCodeError(
        LessonVisualRenderFailure.COMPILE,
        'Only react and remotion imports are supported.',
      );
    }
  }
  if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.COMPILE,
      'External module exports and import assignments are unsupported.',
    );
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  ) {
    throw new LessonVisualCodeError(
      LessonVisualRenderFailure.COMPILE,
      'Dynamic module loading is unsupported.',
    );
  }
  ts.forEachChild(node, checkImports);
}
