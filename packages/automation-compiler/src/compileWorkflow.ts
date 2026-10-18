import type { WorkflowDiagnostic, WorkflowMeta } from "@t3tools/contracts";
import type { Node } from "oxc-parser";

import { WORKER_MODULE_START, type WorkflowCompileResult } from "@signalbox/automations/compiled";
import { WorkflowAnalyzer, type Edit, type FunctionNode } from "./analyze.ts";
import { objectProperties, unwrap } from "./literals.ts";
import { readMeta } from "./meta.ts";
import { parseSync, transformSync } from "./oxc.ts";
import { schemaNamespaceImports } from "./schemaContract.ts";
import { WorkflowSource } from "./source.ts";
import { SDK_MODULE } from "./verbs.ts";
import { declaredNames, isFunctionNode, someNode } from "./walk.ts";

const FILENAME = "automation.ts";
const MAX_DIAGNOSTICS = 50;
const SHAPE_HINT = "export default workflow(async (w, input) => { … })";
/** Holds the default export inside the worker module's factory. */
const WORKER_DEFAULT = "__signalboxWorkflow";

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
  const schemaImports = schemaNamespaceImports(program.body);
  const imported = new Set<string>();
  const removals: Edit[] = [];
  const contractEdits: Edit[] = [];
  const sdkImports: Edit[] = [];
  /** Turns `meta` and the default export into plain declarations, for the worker module. */
  const unexports: Edit[] = [];
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
          meta = readMeta(source, declarator.init, schemaImports);
          if (meta) {
            const properties = objectProperties(declarator.init);
            for (const field of ["input", "output"] as const) {
              const contract = meta[field];
              const node = properties?.get(field);
              if (contract !== undefined && node) {
                contractEdits.push({
                  start: node.start,
                  end: node.end,
                  text: JSON.stringify(contract),
                });
              }
            }
          }
          unexports.push({ start: statement.start, end: declaration.start, text: "" });
        } else {
          source.error(statement, "Only meta and the default workflow can be exported.");
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        workflowExport = statement;
        unexports.push({
          start: statement.start,
          end: statement.declaration.start,
          text: `const ${WORKER_DEFAULT} = `,
        });
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

  const scriptEdits = [...analyzer.edits.values(), ...removals, ...contractEdits];
  const transformed = transformSync(FILENAME, applyEdits(text, scriptEdits), {
    lang: "ts",
    sourceType: "module",
  });
  const worker = transformSync(FILENAME, applyEdits(text, [...scriptEdits, ...unexports]), {
    lang: "ts",
    sourceType: "module",
  });
  const prepareErrors = [...transformed.errors, ...worker.errors];
  if (prepareErrors.length > 0) {
    return failure(
      prepareErrors.map((error) => ({
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
      ...contractEdits,
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
  return {
    ok: true,
    workflow: {
      meta,
      graph: { nodes },
      script: transformed.code,
      runModule,
      workerModule: workerModule(worker.code),
    },
  };
}

/**
 * Wraps the script, with its exports turned into declarations, in one
 * factory. A Dynamic Worker's isolate is shared by every run of the version,
 * so each run calls `load` for top-level state of its own.
 */
function workerModule(code: string) {
  return `${WORKER_MODULE_START}\n${code}\nreturn ${WORKER_DEFAULT};\n}\n`;
}
