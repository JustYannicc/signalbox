import type { WorkflowDiagnostic, WorkflowGraph, WorkflowMeta } from "@t3tools/contracts";
import { parseSync, type Node } from "oxc-parser";
import { transformSync } from "oxc-transform";

import { WorkflowAnalyzer, type Edit, type FunctionNode } from "./analyze.ts";
import { unwrap } from "./literals.ts";
import { readMeta } from "./meta.ts";
import { WorkflowSource } from "./source.ts";
import { SDK_MODULE } from "./verbs.ts";
import { declaredNames, isFunctionNode, someNode } from "./walk.ts";

/**
 * A compiled automation.
 *
 * `script` is the plain module the sandbox runs: types stripped, every step
 * call carrying its graph id as an extra first argument, and imports and
 * `w.run` functions removed. `runModule` holds the rest of the file as JS, minus
 * the workflow itself, exporting the `w.run` functions; it runs in a real
 * runtime with packages and network.
 */
export interface CompiledWorkflow {
  readonly meta: WorkflowMeta;
  readonly graph: WorkflowGraph;
  readonly script: string;
  readonly runModule: string | null;
}

export type WorkflowCompileResult =
  | { readonly ok: true; readonly workflow: CompiledWorkflow }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

const FILENAME = "automation.ts";
const MAX_DIAGNOSTICS = 50;
const SHAPE_HINT = "export default workflow(async (w, input) => { … })";

function failure(diagnostics: ReadonlyArray<WorkflowDiagnostic>): WorkflowCompileResult {
  const seen = new Set<string>();
  const unique = diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.line - b.line || a.column - b.column);
  return { ok: false, diagnostics: unique.slice(0, MAX_DIAGNOSTICS) };
}

function applyEdits(text: string, edits: Iterable<Edit>) {
  let result = text;
  // Later positions first; inserts at the same position keep the order they were added in.
  const ordered = [...edits].map((edit, order) => ({ edit, order }));
  ordered.sort((a, b) => b.edit.start - a.edit.start || b.order - a.order);
  for (const { edit } of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** The names a top-level statement declares, for spotting `w.run` functions. */
function declaredBy(statement: Node): string[] {
  if (statement.type === "FunctionDeclaration") return statement.id ? [statement.id.name] : [];
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.flatMap((declarator) =>
      declarator.id.type === "Identifier" ? [declarator.id.name] : [],
    );
  }
  return [];
}

/** The identifiers `node` refers to, including inside nested functions. */
function referencedNames(node: Node) {
  const names = new Set<string>();
  someNode(
    node,
    (child) => {
      if (child.type === "Identifier") names.add(child.name);
      return false;
    },
    true,
  );
  return names;
}

/**
 * Top-level declarations only `w.run` functions reach, such as a `gh()`
 * helper several of them share. They run in Node with the run functions, so
 * they may use packages, and they stay out of the sandbox.
 */
function runOnlyDeclarations(
  statements: ReadonlyArray<Node>,
  workflowFn: Node | null,
  runFunctions: ReadonlySet<string>,
) {
  const byName = new Map<string, Node>();
  for (const statement of statements) {
    for (const name of declaredBy(statement)) byName.set(name, statement);
  }
  const reach = (roots: Iterable<Node>, skip: ReadonlySet<string>) => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      for (const name of referencedNames(queue.pop()!)) {
        const statement = byName.get(name);
        if (!statement || seen.has(name) || skip.has(name)) continue;
        seen.add(name);
        queue.push(statement);
      }
    }
    return seen;
  };
  const fromWorkflow = reach(workflowFn ? [workflowFn] : [], runFunctions);
  const runRoots = [...runFunctions].flatMap((name) => {
    const statement = byName.get(name);
    return statement ? [statement] : [];
  });
  const fromRuns = reach(runRoots, new Set());
  return new Set([...fromRuns].filter((name) => !fromWorkflow.has(name)));
}

/**
 * Compiles an automation file. The diagram is derived from the code, so code
 * the compiler can't place in the diagram is rejected with diagnostics
 * instead of being shown approximately.
 */
export function compileWorkflow(text: string): WorkflowCompileResult {
  const source = new WorkflowSource(text);
  const parsed = parseSync(FILENAME, text, {
    lang: "ts",
    sourceType: "module",
    preserveParens: false,
  });
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      source.error(
        { start: error.labels[0]?.start ?? 0, end: 0 },
        error.message,
        error.helpMessage ?? undefined,
      );
    }
    return failure(source.diagnostics);
  }
  source.setComments(parsed.comments);

  const program = parsed.program;
  const imported = new Set<string>();
  const removals: Edit[] = [];
  const sdkImports: Edit[] = [];
  const rest: Node[] = [];
  let meta: WorkflowMeta | null = null;
  let sawMeta = false;
  let workflowFn: FunctionNode | null = null;
  let workflowExport: Node | null = null;

  for (const statement of program.body) {
    switch (statement.type) {
      case "ImportDeclaration":
        if (statement.importKind === "type") break;
        removals.push({ start: statement.start, end: statement.end, text: "" });
        if (statement.source.value === SDK_MODULE) {
          sdkImports.push({ start: statement.start, end: statement.end, text: "" });
        } else {
          for (const specifier of statement.specifiers) imported.add(specifier.local.name);
        }
        break;
      case "ExportNamedDeclaration": {
        const declaration = statement.declaration;
        if (statement.exportKind === "type" || declaration?.type.startsWith("TS")) break;
        const declarator =
          declaration?.type === "VariableDeclaration" ? declaration.declarations[0] : undefined;
        if (
          declaration?.type === "VariableDeclaration" &&
          declaration.kind === "const" &&
          declaration.declarations.length === 1 &&
          declarator?.id.type === "Identifier" &&
          declarator.id.name === "meta" &&
          declarator.init
        ) {
          sawMeta = true;
          meta = readMeta(source, declarator.init);
        } else {
          source.error(statement, "Only meta and the default workflow can be exported.");
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        workflowExport = statement;
        const declaration = unwrap(statement.declaration as Node);
        const fn = declaration.type === "CallExpression" ? declaration.arguments[0] : undefined;
        if (
          declaration.type !== "CallExpression" ||
          declaration.callee.type !== "Identifier" ||
          declaration.callee.name !== "workflow" ||
          declaration.arguments.length !== 1 ||
          !fn ||
          !isFunctionNode(fn)
        ) {
          source.error(
            statement,
            "The default export must be workflow(async (w, input) => { … }).",
            SHAPE_HINT,
          );
        } else {
          workflowFn = fn as FunctionNode;
        }
        break;
      }
      case "ExportAllDeclaration":
        source.error(statement, "Only meta and the default workflow can be exported.");
        break;
      default:
        rest.push(statement);
    }
  }

  if (!sawMeta) {
    source.error(
      { start: 0, end: 0 },
      "Export the automation's meta.",
      'export const meta = { name: "Weekly report", triggers: [{ cron: "0 9 * * 1" }] } as const',
    );
  }
  if (!workflowFn || !workflowExport) {
    source.error({ start: 0, end: 0 }, "Export the workflow as the default export.", SHAPE_HINT);
  }

  const analyzer = new WorkflowAnalyzer({
    source,
    declared: declaredNames(program),
    imported,
    moduleFunctions: WorkflowAnalyzer.functionsIn(program.body),
  });
  const nodes = workflowFn ? analyzer.workflow(workflowFn) : [];
  const runOnly = runOnlyDeclarations(rest, workflowFn, analyzer.runFunctions);
  for (const statement of rest) {
    const names = declaredBy(statement);
    if (
      names.some((name) => analyzer.runFunctions.has(name)) ||
      (names.length > 0 && names.every((name) => runOnly.has(name)))
    ) {
      removals.push({ start: statement.start, end: statement.end, text: "" });
    } else {
      analyzer.topLevel(statement);
    }
  }
  if (source.diagnostics.length > 0 || !meta || !workflowExport) return failure(source.diagnostics);

  const transformed = transformSync(
    FILENAME,
    applyEdits(text, [...analyzer.edits.values(), ...removals]),
    {
      lang: "ts",
      sourceType: "module",
    },
  );
  if (transformed.errors.length > 0) {
    return failure(
      transformed.errors.map((error) => ({
        message: `Couldn't prepare the automation to run: ${error.message}`,
        line: 1,
        column: 1,
      })),
    );
  }
  let runModule: string | null = null;
  if (analyzer.runFunctions.size > 0) {
    const exportsList = [...analyzer.runFunctions].join(", ");
    const withoutWorkflow = applyEdits(text, [
      ...sdkImports,
      { start: workflowExport.start, end: workflowExport.end, text: "" },
    ]);
    const runTransformed = transformSync(
      FILENAME,
      `${withoutWorkflow}\nexport { ${exportsList} };\n`,
      {
        lang: "ts",
        sourceType: "module",
      },
    );
    if (runTransformed.errors.length > 0) {
      return failure([
        {
          message: `Couldn't prepare the w.run functions: ${runTransformed.errors[0]!.message}`,
          line: 1,
          column: 1,
        },
      ]);
    }
    runModule = runTransformed.code;
  }
  return { ok: true, workflow: { meta, graph: { nodes }, script: transformed.code, runModule } };
}
