import ts from "typescript-legacy";
import type { AjvCompileSite } from "./ajv-precompile-runtime.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface AjvProfile {
  dialect: "draft7" | "2019" | "2020";
  options: { [key: string]: JsonValue };
}
export interface AjvDiagnostic {
  code: "AJV_DYNAMIC_SCHEMA" | "AJV_UNKNOWN_PROFILE" | "AJV_RUNTIME_API" | "AJV_PARSE_ERROR";
  module: string;
  offset: number;
  message: string;
}
export interface DiscoveredAjvCall {
  site: AjvCompileSite;
  start: number;
  end: number;
  receiver: string;
  argument: string;
  schema?: JsonValue;
  profile?: AjvProfile;
}
export interface AjvModuleAnalysis {
  key: string;
  source: string;
  calls: DiscoveredAjvCall[];
  diagnostics: AjvDiagnostic[];
  unclassifiedCompileCalls: number[];
  format?: "commonjs" | "module" | 1 | 2;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// Binding through the checker keeps minified variables in separate lexical scopes.
export function discoverAjvSchemas(input: {
  key: string;
  source: string;
  format?: "commonjs" | "module" | 1 | 2;
}): AjvModuleAnalysis {
  const compilerFileName = /\.(?:[cm]?js|jsx)$/i.test(input.key) ? input.key : `${input.key}.js`;
  const sourceFile = ts.createSourceFile(
    compilerFileName,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const host = ts.createCompilerHost({ allowJs: true, noLib: true });
  host.getSourceFile = (name) => (name === compilerFileName ? sourceFile : undefined);
  host.fileExists = (name) => name === compilerFileName;
  host.readFile = (name) => (name === compilerFileName ? input.source : undefined);
  const program = ts.createProgram(
    [compilerFileName],
    { allowJs: true, noLib: true, noResolve: true },
    host,
  );
  const checker = program.getTypeChecker();
  const result: AjvModuleAnalysis = {
    ...input,
    calls: [],
    diagnostics: [],
    unclassifiedCompileCalls: [],
  };
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const writes = new Set<ts.Symbol>();
  const schemaReceivers = new Set<ts.Symbol>();
  const exportedBindings = new Set<ts.Symbol>();
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  function root(node: ts.Expression): ts.Expression {
    if (ts.isParenthesizedExpression(node)) return root(node.expression);
    return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
      ? root(node.expression)
      : node;
  }
  walk(sourceFile, (node) => {
    if (ts.isExportSpecifier(node)) {
      const bound = checker.getExportSpecifierLocalTargetSymbol(node);
      if (bound) exportedBindings.add(bound);
    }
    if (ts.isIdentifier(node)) {
      const bound = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : symbol(node);
      if (bound) {
        const uses = references.get(bound) ?? [];
        uses.push(node);
        references.set(bound, uses);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const bound = symbol(root(node.left));
      if (bound) writes.add(bound);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "validateSchema"
    ) {
      const bound = symbol(node.expression.expression);
      if (bound) schemaReceivers.add(bound);
    }
  });
  // A receiver stays static only when its entire use is visible as direct compile calls.
  function onlyCompileReceiver(bound: ts.Symbol) {
    if (bound.declarations?.length !== 1 || exportedBindings.has(bound)) return false;
    const declaration = bound.declarations[0];
    if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
    const statement = declaration.parent.parent;
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return false;
    return (references.get(bound) ?? []).every((reference) => {
      if (reference === declaration.name) return true;
      const property = reference.parent;
      return (
        ts.isPropertyAccessExpression(property) &&
        property.expression === reference &&
        property.name.text === "compile" &&
        ts.isCallExpression(property.parent) &&
        property.parent.expression === property
      );
    });
  }
  function initializer(node: ts.Identifier): ts.Expression | undefined {
    const bound = symbol(node);
    if (!bound || writes.has(bound) || bound.declarations?.length !== 1) return;
    const declaration = bound.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : undefined;
  }
  function literal(node: ts.Expression, seen = new Set<ts.Node>(), inlineOnly = false): JsonValue {
    if (seen.has(node)) throw new Error("Circular binding");
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node)) return literal(node.expression, seen, inlineOnly);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
      return value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node)) {
      const value = literal(node.operand, seen, inlineOnly);
      if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
      if (typeof value === "number" && node.operator === ts.SyntaxKind.MinusToken) return -value;
      if (typeof value === "number" && node.operator === ts.SyntaxKind.PlusToken) return value;
    }
    if (ts.isIdentifier(node)) {
      if (inlineOnly) throw new Error("Static options must be inline JSON literals");
      const value = initializer(node);
      if (value) return literal(value, seen, inlineOnly);
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((element) => {
        if (ts.isSpreadElement(element)) throw new Error("Array spread is unresolved");
        return literal(element, seen, inlineOnly);
      });
    if (ts.isObjectLiteralExpression(node)) {
      const value: { [key: string]: JsonValue } = Object.create(null);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          if (inlineOnly) throw new Error("Static options cannot contain spreads");
          const spread = literal(property.expression, seen, inlineOnly);
          if (!spread || typeof spread !== "object" || Array.isArray(spread))
            throw new Error("Non-object spread");
          Object.assign(value, spread);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          if (inlineOnly) throw new Error("Static options cannot contain shorthand bindings");
          const bound = checker.getShorthandAssignmentValueSymbol(property);
          const declaration = bound?.valueDeclaration;
          if (
            !bound ||
            writes.has(bound) ||
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer
          )
            throw new Error("Unresolved shorthand");
          value[property.name.text] = literal(declaration.initializer, seen, inlineOnly);
        } else if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) {
          if (property.name.text === "__proto__")
            throw new Error("Prototype-setting properties are not static JSON");
          value[property.name.text] = literal(property.initializer, seen, inlineOnly);
        } else throw new Error("Schema property is not static JSON");
      }
      return value;
    }
    throw new Error("Expression is not static JSON");
  }
  function dialectName(name: string): AjvProfile["dialect"] | undefined {
    return name === "Ajv2020"
      ? "2020"
      : name === "Ajv2019"
        ? "2019"
        : name === "Ajv"
          ? "draft7"
          : undefined;
  }
  function constructorDialect(
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): AjvProfile["dialect"] | undefined {
    if (seen.has(node)) return;
    seen = new Set(seen).add(node);
    if (ts.isPropertyAccessExpression(node)) {
      const named = dialectName(node.name.text);
      if (named) return named;
      if (node.name.text === "default") return constructorDialect(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      const declaration = symbol(node)?.declarations?.[0];
      if (declaration && ts.isBindingElement(declaration))
        return dialectName((declaration.propertyName ?? declaration.name).getText(sourceFile));
      if (
        declaration &&
        (ts.isImportClause(declaration) ||
          ts.isImportSpecifier(declaration) ||
          ts.isNamespaceImport(declaration))
      ) {
        const imported = ts.isImportClause(declaration)
          ? declaration.parent
          : ts.isImportSpecifier(declaration)
            ? declaration.parent.parent.parent
            : declaration.parent.parent;
        if (ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier)) {
          const path = imported.moduleSpecifier.text;
          if (/^ajv(?:\/dist\/(2019|2020)(?:\.js)?)?$/.test(path))
            return path.includes("2020") ? "2020" : path.includes("2019") ? "2019" : "draft7";
        }
      }
      const value = initializer(node);
      if (value) return constructorDialect(value, seen);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      const path = node.arguments[0];
      if (
        path &&
        ts.isStringLiteral(path) &&
        /^ajv(?:\/dist\/(2019|2020)(?:\.js)?)?$/.test(path.text)
      )
        return path.text.includes("2020") ? "2020" : path.text.includes("2019") ? "2019" : "draft7";
    }
    return;
  }
  function receiver(
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): { recognized: boolean; profile?: AjvProfile } {
    if (seen.has(node)) return { recognized: false };
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node)) return receiver(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const bound = symbol(node);
      const declarations = bound?.declarations ?? [];
      const resolved = declarations
        .filter(ts.isVariableDeclaration)
        .flatMap((declaration) =>
          declaration.initializer ? [receiver(declaration.initializer, seen)] : [],
        )
        .find((candidate) => candidate.recognized);
      if (resolved) return bound && onlyCompileReceiver(bound) ? resolved : { recognized: true };
      if (bound && schemaReceivers.has(bound)) return { recognized: true };
    }
    if (ts.isPropertyAccessExpression(node) && /^(?:_?ajv)$/.test(node.name.text))
      return { recognized: true };
    if (ts.isNewExpression(node)) {
      const dialect = constructorDialect(node.expression);
      if (!dialect) return { recognized: false };
      try {
        if ((node.arguments?.length ?? 0) > 1) return { recognized: true };
        const options = node.arguments?.[0] ? literal(node.arguments[0], new Set(), true) : {};
        if (!options || typeof options !== "object" || Array.isArray(options))
          return { recognized: true };
        return { recognized: true, profile: { dialect, options } };
      } catch {
        return { recognized: true };
      }
    }
    return { recognized: false };
  }
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    if (
      ![
        "compile",
        "compileAsync",
        "validateSchema",
        "validate",
        "getSchema",
        "addSchema",
        "addFormat",
        "addKeyword",
      ].includes(method)
    )
      return;
    const target = node.expression.expression;
    const resolved = receiver(target);
    if (!resolved.recognized) {
      if (method === "compile") result.unclassifiedCompileCalls.push(node.getStart(sourceFile));
      return;
    }
    const offset = node.getStart(sourceFile);
    const diagnostic = (code: AjvDiagnostic["code"], message: string) =>
      result.diagnostics.push({ code, module: input.key, offset, message });
    if (method !== "compile") {
      diagnostic(
        "AJV_RUNTIME_API",
        `${method} requires AJV runtime state and may generate code; standalone compile replacement does not cover it`,
      );
      return;
    }
    const site: AjvCompileSite = { id: `${input.key}:${offset}`, module: input.key, offset };
    const argument = node.arguments[0];
    const call: DiscoveredAjvCall = {
      site,
      start: offset,
      end: node.end,
      receiver: target.getText(sourceFile),
      argument: argument?.getText(sourceFile) ?? "undefined",
    };
    if (resolved.profile) call.profile = resolved.profile;
    else
      diagnostic(
        "AJV_UNKNOWN_PROFILE",
        "AJV dialect, constructor options, or custom formats cannot be resolved statically",
      );
    try {
      if (!argument || node.arguments.length !== 1 || ts.isSpreadElement(argument))
        throw new Error("Expected one schema argument");
      call.schema = literal(argument);
      if (
        call.schema &&
        typeof call.schema === "object" &&
        !Array.isArray(call.schema) &&
        Object.hasOwn(call.schema, "$id")
      ) {
        diagnostic(
          "AJV_RUNTIME_API",
          "Compiling a schema with $id registers runtime state; preserve the interpreter call",
        );
        delete call.profile;
      }
    } catch {
      diagnostic(
        "AJV_DYNAMIC_SCHEMA",
        "Schema depends on runtime input; supply a non-codegen validator or external compiler",
      );
    }
    const issue = result.diagnostics.find((item) => item.offset === offset);
    if (issue) site.reason = issue.message;
    result.calls.push(call);
  });
  for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
    result.diagnostics.push({
      code: "AJV_PARSE_ERROR",
      module: input.key,
      offset: diagnostic.start ?? 0,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    });
  }
  return result;
}
