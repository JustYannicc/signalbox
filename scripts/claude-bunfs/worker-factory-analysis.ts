import ts from "typescript-legacy";
import {
  computedKeyKind,
  createContext,
  hasLocalDeclaration,
  isImplicitArguments,
  isJSDoc,
  isReference,
  point,
  referenceSymbol,
  sortedSites,
} from "./worker-factory-lexical.ts";
import {
  callKind,
  collectAliases,
  expressionPath,
  globalRootFor,
  intrinsicValue,
} from "./worker-factory-capabilities.ts";
import type { WorkerFactorySite } from "./worker-factory-lexical.ts";

export type { WorkerFactorySite } from "./worker-factory-lexical.ts";

export interface WorkerFactoryAnalysis {
  readonly globals: ReadonlyArray<string>;
  /** JSON tuples: [specifier, imported name, local name]. */
  readonly imports: ReadonlyArray<string>;
  readonly computedGlobalAccess: {
    readonly count: number;
    readonly sites: ReadonlyArray<WorkerFactorySite>;
  };
  readonly functionConstructors: {
    readonly count: number;
    readonly sites: ReadonlyArray<WorkerFactorySite>;
  };
}

const realmIntrinsics = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "AsyncDisposableStack",
  "AsyncIterator",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "DisposableStack",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Intl",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "SuppressedError",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "eval",
  "escape",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
  "unescape",
]);

export function analyzeWorkerFactory(source: string, filename: string): WorkerFactoryAnalysis {
  const context = createContext(source, filename);
  const aliases = collectAliases(context);
  const globals = new Set<string>();
  const computedSites: WorkerFactorySite[] = [];
  const functionSites: WorkerFactorySite[] = [];
  const visit = (node: ts.Node): void => {
    if (isJSDoc(node)) return;
    if (ts.isIdentifier(node) && isReference(node) && !isImplicitArguments(node)) {
      const symbol = referenceSymbol(node, context.checker);
      if (!hasLocalDeclaration(symbol, context.file) && !realmIntrinsics.has(node.text))
        globals.add(node.text);
    }
    if (ts.isWithStatement(node)) {
      const site = point(context.file, filename, node);
      throw new SyntaxError(`WORKER_FACTORY_WITH: ${site.source}:${site.line}:${site.column}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const global = globalRootFor(node.expression, context, aliases.globalObjects);
      if (global) {
        const site = point(context.file, filename, node);
        const path = expressionPath(node.expression);
        const chain = path.parts.filter((part): part is string => part !== undefined);
        const base = global.alias ? `alias(${global.alias}:${global.root})` : global.root;
        computedSites.push({
          ...site,
          kind: `${base}${chain.length ? `.${chain.join(".")}` : ""}[${computedKeyKind(node.argumentExpression)}]`,
        });
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (intrinsicValue(node.expression, "eval", context, aliases.globalObjects, aliases.evals)) {
        const site = point(context.file, filename, node);
        throw new SyntaxError(`WORKER_FACTORY_EVAL: ${site.source}:${site.line}:${site.column}`);
      }
      const functionValue = intrinsicValue(
        node.expression,
        "function",
        context,
        aliases.globalObjects,
        aliases.functions,
      );
      if (functionValue) {
        const site = point(context.file, filename, node);
        functionSites.push({ ...site, kind: callKind(node, functionValue, context, aliases) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(context.file);
  const computedGlobalAccess = sortedSites(computedSites);
  const functionConstructors = sortedSites(functionSites);
  return {
    globals: [...globals].sort(),
    imports: context.importBindings,
    computedGlobalAccess: {
      count: computedGlobalAccess.length,
      sites: computedGlobalAccess,
    },
    functionConstructors: {
      count: functionConstructors.length,
      sites: functionConstructors,
    },
  };
}

export { rewriteLexicalReferences } from "./worker-factory-rewrite.ts";
