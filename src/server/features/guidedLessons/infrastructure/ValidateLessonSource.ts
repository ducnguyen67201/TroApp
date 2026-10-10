import ts from 'typescript';
import { LessonCodeSandboxError, LessonCodeStage } from './LessonCodeSandbox.js';

const ReactImports = new Set([
  'Fragment',
  'memo',
  'useMemo',
  'CSSProperties',
  'ReactNode',
  'ReactElement',
  'FC',
  'ComponentType',
]);
const RemotionImports = new Set([
  'AbsoluteFill',
  'Sequence',
  'Series',
  'Freeze',
  'Loop',
  'Easing',
  'interpolate',
  'interpolateColors',
  'spring',
  'measureSpring',
  'useCurrentFrame',
  'useVideoConfig',
]);
const PureGlobals = new Set([
  'Array',
  'Boolean',
  'Number',
  'String',
  'Math',
  'Object',
  'JSON',
  'Infinity',
  'NaN',
  'undefined',
  'parseInt',
  'parseFloat',
  'isFinite',
  'isNaN',
  'Record',
  'Readonly',
  'ReadonlyArray',
  'Partial',
  'Required',
  'Pick',
  'Omit',
  'NonNullable',
]);
const ForbiddenNames = new Set([
  'console',
  'window',
  'document',
  'globalThis',
  'global',
  'self',
  'process',
  'navigator',
  'location',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'SharedWorker',
  'importScripts',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'queueMicrotask',
  'eval',
  'Function',
  'require',
  'module',
  'exports',
  'Buffer',
  'Deno',
  'Bun',
  'WebAssembly',
  'Date',
  'performance',
  'crypto',
  'Audio',
  'Video',
  'Image',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'EventSource',
  'BroadcastChannel',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'URL',
  'URLSearchParams',
  'Reflect',
  'Proxy',
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'getPrototypeOf',
  'setPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'defineProperty',
  'defineProperties',
  'random',
  'useEffect',
  'useLayoutEffect',
  'useState',
  'useRef',
  'useReducer',
  'useImperativeHandle',
  'createElement',
  'cloneElement',
]);
const HtmlElements = new Set([
  'div',
  'span',
  'p',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'h1',
  'h2',
  'h3',
  'h4',
  'section',
  'main',
  'article',
  'header',
  'footer',
  'aside',
  'ul',
  'ol',
  'li',
  'br',
  'hr',
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
]);
const ForbiddenAttributes = new Set([
  'dangerouslysetinnerhtml',
  'ref',
  'src',
  'srcset',
  'href',
  'xlinkhref',
  'action',
  'formaction',
  'contenteditable',
  'is',
]);

function rejectSource(reason: string): never {
  throw new LessonCodeSandboxError(LessonCodeStage.COMPILE, `Source quality contract: ${reason}`);
}

/** Numeric syntax evidence helps repair without quoting source text or diagnostic messages. */
function formatSyntaxDiagnostic(diagnostic: ts.Diagnostic, source: ts.SourceFile): string {
  const code = `TS${String(diagnostic.code)}`;
  if (
    diagnostic.start === undefined ||
    diagnostic.start < 0 ||
    diagnostic.start > source.text.length
  ) {
    return `${code} (location unavailable)`;
  }
  const position = source.getLineAndCharacterOfPosition(diagnostic.start);
  return `${code} at line ${String(position.line + 1)}, column ${String(position.character + 1)}`;
}

function hasExternalCssAsset(value: string): boolean {
  for (const match of value.matchAll(/url\(([^)]*)\)/gi)) {
    const target = match[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    if (!target.startsWith('#')) {
      return true;
    }
  }
  return false;
}

function readConstantProperty(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return readConstantProperty(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = readConstantProperty(expression.left);
    const right = readConstantProperty(expression.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function isPropertyName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isQualifiedName(parent) && parent.right === identifier) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isJsxAttribute(parent)) &&
      parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ((ts.isJsxOpeningElement(parent) ||
      ts.isJsxClosingElement(parent) ||
      ts.isJsxSelfClosingElement(parent)) &&
      parent.tagName === identifier)
  );
}

function validateImport(
  declaration: ts.ImportDeclaration,
  names: Set<string>,
  reactNames: Set<string>,
): void {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) {
    rejectSource('Imports must name a permitted package directly.');
  }
  const moduleName = declaration.moduleSpecifier.text;
  if (moduleName !== 'react' && moduleName !== 'remotion') {
    rejectSource('Only react and the supported remotion APIs may be imported.');
  }
  const clause = declaration.importClause;
  if (!clause) {
    rejectSource('Side-effect imports are not supported.');
  }
  if (clause.name) {
    if (moduleName !== 'react') {
      rejectSource('Remotion APIs must use named imports.');
    }
    names.add(clause.name.text);
    reactNames.add(clause.name.text);
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    if (moduleName !== 'react') {
      rejectSource('Remotion APIs must use named imports.');
    }
    names.add(bindings.name.text);
    reactNames.add(bindings.name.text);
  } else if (bindings) {
    for (const binding of bindings.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (!(moduleName === 'react' ? ReactImports : RemotionImports).has(imported)) {
        rejectSource('An imported API is outside the supported pure presentation APIs.');
      }
      names.add(binding.name.text);
    }
  }
}

/**
 * Enforce the pure, frame-driven source contract and reject easy measurement spoofing.
 * This AST check is a quality guard, not a JavaScript security sandbox. Docker remains
 * the execution boundary; source is never evaluated or type-checked on the API host.
 */
export function validateLessonSource(source: string): void {
  const parsed = ts.createSourceFile(
    'Scene.tsx',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const compiled = ts.transpileModule(source, {
    fileName: 'Scene.tsx',
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const syntaxErrors =
    compiled.diagnostics?.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ) ?? [];
  if (syntaxErrors.length > 0) {
    const maximumDiagnostics = 3;
    const locations = syntaxErrors
      .slice(0, maximumDiagnostics)
      .map((diagnostic) => formatSyntaxDiagnostic(diagnostic, parsed));
    const remaining = syntaxErrors.length - locations.length;
    rejectSource(
      `The TSX module has a syntax error: ${locations.join('; ')}.${remaining > 0 ? ` ${String(remaining)} additional diagnostics omitted.` : ''}`,
    );
  }
  const names = new Set<string>();
  const reactNames = new Set<string>();
  let defaultExports = 0;
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      validateImport(node, names, reactNames);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      collectBindingNames(node.name, names);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isTypeParameterDeclaration(node)) &&
      node.name
    ) {
      names.add(node.name.text);
    }
    if (
      (ts.canHaveModifiers(node) &&
        ts
          .getModifiers(node)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) ||
      (ts.isExportAssignment(node) && !node.isExportEquals)
    ) {
      defaultExports += 1;
    }
    ts.forEachChild(node, collect);
  };
  collect(parsed);
  if (defaultExports !== 1) {
    rejectSource('Export exactly one default React component.');
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (ForbiddenNames.has(node.text)) {
        rejectSource(
          'DOM, global, stateful, nondeterministic and reflective APIs are not supported.',
        );
      }
      if (!isPropertyName(node) && !names.has(node.text) && !PureGlobals.has(node.text)) {
        rejectSource('References must use local bindings or supported pure presentation APIs.');
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      reactNames.has(node.expression.text) &&
      !ReactImports.has(node.name.text)
    ) {
      rejectSource('React namespace access is restricted to the supported pure APIs.');
    }
    if (ts.isElementAccessExpression(node)) {
      const property = readConstantProperty(node.argumentExpression);
      if (
        (property !== null && ForbiddenNames.has(property)) ||
        (ts.isIdentifier(node.expression) &&
          (reactNames.has(node.expression.text) || PureGlobals.has(node.expression.text)))
      ) {
        rejectSource('Reflective properties and computed global API access are not supported.');
      }
    }
    if (ts.isStringLiteralLike(node) && hasExternalCssAsset(node.text)) {
      rejectSource('External CSS assets are not supported.');
    }
    if (
      ts.isNewExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      ts.isExportDeclaration(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isWithStatement(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.AsyncKeyword ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      rejectSource('Use synchronous pure functions and static permitted imports.');
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(parsed);
      if (/^[a-z]/.test(tag) && !HtmlElements.has(tag)) {
        rejectSource('Script, media, embedded HTML and unsupported JSX elements are not allowed.');
      }
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          rejectSource('JSX properties must be explicit; spread attributes are not supported.');
        }
        const attributeName = attribute.name.getText(parsed).toLowerCase();
        if (attributeName.startsWith('on') || ForbiddenAttributes.has(attributeName)) {
          rejectSource('Events, DOM references, URLs and HTML injection are not allowed.');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}
