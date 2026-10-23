// @effect-diagnostics nodeBuiltinImport:off - build-time source analysis.
import * as NodePath from "node:path";
import ts from "typescript-legacy";

export interface WorkerFactorySite {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
}

export interface AnalysisContext {
  readonly file: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly importBindings: ReadonlyArray<string>;
}

export function createContext(source: string, filename: string): AnalysisContext {
  const filePath = NodePath.resolve(filename);
  const matchesFile = (requested: string) => NodePath.resolve(requested) === filePath;
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.getSourceFile = (requested, version, onError, createNewSourceFile) =>
    matchesFile(requested)
      ? ts.createSourceFile(filePath, source, version, true, ts.ScriptKind.JS)
      : originalGetSourceFile(requested, version, onError, createNewSourceFile);
  host.fileExists = (requested) => matchesFile(requested) || originalFileExists(requested);
  host.readFile = (requested) => (matchesFile(requested) ? source : originalReadFile(requested));

  const program = ts.createProgram([filePath], options, host);
  const file = program.getSourceFile(filePath);
  if (!file) throw new Error(`WORKER_FACTORY_SOURCE_MISSING: ${filename}`);
  const diagnostics = Reflect.get(file, "parseDiagnostics") as
    | ReadonlyArray<ts.Diagnostic>
    | undefined;
  if (diagnostics?.length) {
    const diagnostic = diagnostics[0]!;
    const point = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new SyntaxError(
      `WORKER_FACTORY_PARSE_ERROR: ${filename}:${point.line + 1}:${point.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }

  const checker = program.getTypeChecker();
  const importBindings = new Set<string>();
  const addImport = (specifier: string, imported: string, local: ts.Identifier | undefined) => {
    const localName = local?.text ?? "";
    importBindings.add(JSON.stringify([specifier, imported, localName]));
  };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause;
    if (!clause) {
      addImport(statement.moduleSpecifier.text, "side-effect", undefined);
      continue;
    }
    if (clause.isTypeOnly) continue;
    if (clause.name) addImport(statement.moduleSpecifier.text, "default", clause.name);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      addImport(statement.moduleSpecifier.text, "*", bindings.name);
    else if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (!element.isTypeOnly)
          addImport(
            statement.moduleSpecifier.text,
            (element.propertyName ?? element.name).text,
            element.name,
          );
  }
  return {
    file,
    checker,
    importBindings: [...importBindings].sort(),
  };
}

export function symbolOf(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(node);
}

export function referenceSymbol(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const parent = node.parent;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : checker.getSymbolAtLocation(node);
}

export function hasLocalDeclaration(symbol: ts.Symbol | undefined, file: ts.SourceFile): boolean {
  return Boolean(symbol?.declarations?.some((declaration) => declaration.getSourceFile() === file));
}

export function isJSDoc(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (ts.isJSDoc(current)) return true;
  return false;
}

export function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isMetaProperty(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
    parent.name === node
  )
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return false;
  if (ts.isExportSpecifier(parent)) return false;
  if (
    (ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
    parent.label === node
  )
    return false;
  return true;
}

export function isImplicitArguments(node: ts.Identifier): boolean {
  if (node.text !== "arguments") return false;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) return true;
  return false;
}

export function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node)
  )
    node = node.expression;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
    return unwrap(node.right);
  return node;
}

export function staticProperty(node: ts.Expression): string | undefined {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    if (
      argument &&
      (ts.isStringLiteralLike(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument) ||
        ts.isNumericLiteral(argument))
    )
      return argument.text;
  }
  return undefined;
}

export function point(file: ts.SourceFile, filename: string, node: ts.Node): WorkerFactorySite {
  const location = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    source: filename,
    line: location.line + 1,
    column: location.character + 1,
    kind: "",
  };
}

export function sortedSites(
  sites: ReadonlyArray<WorkerFactorySite>,
): ReadonlyArray<WorkerFactorySite> {
  const unique = new Map<string, WorkerFactorySite>();
  for (const site of sites)
    unique.set(JSON.stringify([site.source, site.line, site.column, site.kind]), site);
  return [...unique.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.line - right.line ||
      left.column - right.column ||
      left.kind.localeCompare(right.kind),
  );
}

export function computedKeyKind(node: ts.Expression | undefined): string {
  if (!node) return "missing";
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return JSON.stringify(node.text);
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return "identifier";
  return "expression";
}
