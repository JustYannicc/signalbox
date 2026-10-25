import type { HomeOperations, SyncSchema } from "../definition.ts";
import { emitWireValueValidator, hasDefinedValue, isNeverSchema } from "./lunoraValidators.ts";

type NamedOperations = Readonly<
  Record<
    string,
    { readonly input: SyncSchema; readonly output: SyncSchema; readonly failure: SyncSchema }
  >
>;

type FunctionNames<Definition extends HomeOperations> = {
  readonly views: { readonly [K in keyof Definition["views"]]: `view_${K & string}` };
  readonly changes: { readonly [K in keyof Definition["changes"]]: `change_${K & string}` };
  readonly projections: {
    readonly [K in keyof Definition["projections"]]: `project_${K & string}`;
  };
};

export interface LunoraFunctionsEmission<Definition extends HomeOperations> {
  readonly source: string;
  readonly functions: FunctionNames<Definition>;
}

export interface EmitLunoraFunctionsOptions {
  readonly definitionImport: string;
  readonly definitionExport?: string;
  readonly bindingImport: string;
  readonly serverImport?: string;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fail(path: string, reason: string): never {
  throw new Error(`${path}: ${reason}`);
}

function isIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/u.test(value);
}

function entries(
  operations: NamedOperations,
  prefix: "view" | "change" | "project",
  group: string,
) {
  return Object.entries(operations)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, operation]) => {
      if (!isIdentifier(name)) {
        return fail(
          `${group}.${name}`,
          `operation name ${quote(name)} must be a valid JavaScript identifier`,
        );
      }
      return { name, operation, exportName: `${prefix}_${name}` };
    });
}

function validatorUnion(variants: readonly string[], path: string): string {
  if (variants.length === 0) return fail(path, "operation has no representable result branch");
  return variants.length === 1 ? variants[0]! : `v.union(${variants.join(", ")})`;
}

function viewOutput(operation: NamedOperations[string], path: string): string {
  const variants: string[] = [];
  if (!isNeverSchema(operation.output)) {
    variants.push(
      `v.object({ _tag: v.literal("Value"), value: ${emitWireValueValidator(operation.output, `${path}.value`)}, cursor: v.string() })`,
    );
  }
  if (!isNeverSchema(operation.failure)) {
    variants.push(
      `v.object({ _tag: v.literal("Failure"), failure: ${emitWireValueValidator(operation.failure, `${path}.failure`)} })`,
    );
  }
  return validatorUnion(variants, path);
}

function writeOutput(operation: NamedOperations[string], path: string): string {
  const variants: string[] = [];
  if (!isNeverSchema(operation.output)) {
    variants.push(
      `v.object({ _tag: v.literal("Committed"), value: ${emitWireValueValidator(operation.output, `${path}.value`)}, receipt: v.string() })`,
    );
  }
  variants.push(`v.object({ _tag: v.literal("Pending"), operationKey: v.string() })`);
  return validatorUnion(variants, path);
}

function inputValidator(operation: NamedOperations[string], path: string): string {
  if (isNeverSchema(operation.input) || !hasDefinedValue(operation.input)) {
    const ast = operation.input.ast;
    if (ast._tag === "Never") return fail(path, "operation input cannot be Never");
  }
  return emitWireValueValidator(operation.input, path);
}

function emitView(
  name: string,
  exportName: string,
  input: string,
  output: string,
  hasValue: boolean,
  hasFailure: boolean,
): string {
  const key = quote(name);
  const branches = [
    ...(hasValue
      ? [
          `if (result._tag === "Value") return { ...result, value: await validateOutput(syncDefinition.views[${key}].output, result.value) };`,
        ]
      : []),
    ...(hasFailure
      ? [
          `if (result._tag === "Failure") return { ...result, failure: await validateOutput(syncDefinition.views[${key}].failure, result.failure) };`,
        ]
      : []),
    `throw asLunoraSyncError(new SyncFailure({ reason: "invalid_state" }));`,
  ];
  return `export const ${exportName} = query
  .input({ input: ${input}, resume: v.optional(v.string()) })
  .output(${output})
  .query(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.views[${key}].input, args.input);
    const result = await runtime.observeWire(${key})({
      ctx: readContext(ctx),
      args: {
        actor,
        input,
        ...(args.resume === undefined ? {} : { resume: SyncCursor.make(args.resume) }),
      },
    });
    ${branches.join("\n    ")}
  });`;
}

function emitChange(name: string, exportName: string, input: string, output: string): string {
  const key = quote(name);
  return `export const ${exportName} = mutation
  .input({ input: ${input}, operationKey: v.string() })
  .output(${output})
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes[${key}].input, args.input);
    const result = await runtime.changeWire(${key})({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return { ...result, value: await validateOutput(syncDefinition.changes[${key}].output, result.value) };
    }
    return result;
  });`;
}

function emitProjection(name: string, exportName: string, input: string, output: string): string {
  const key = quote(name);
  return `export const ${exportName} = internalMutation
  .input({ input: ${input}, operationKey: v.string() })
  .output(${output})
  .mutation(async ({ ctx, args }) => {
    const { runtime, ingress } = await bindProjectionHome(ctx);
    const input = await decodeInput(syncDefinition.projections[${key}].input, args.input);
    const result = await runtime.projectionWire(${key})({
      ctx: writeContext(ctx),
      args: { ingress, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return { ...result, value: await validateOutput(syncDefinition.projections[${key}].output, result.value) };
    }
    return result;
  });`;
}

/** Emits ordinary Lunora RPCs for the typed SyncHome operation catalog. */
export function emitLunoraFunctions<const Definition extends HomeOperations>(
  definition: Definition,
  options: EmitLunoraFunctionsOptions,
): LunoraFunctionsEmission<Definition> {
  const definitionExport = options.definitionExport ?? "definition";
  if (!isIdentifier(definitionExport)) {
    return fail("definitionExport", "must be a valid JavaScript identifier");
  }
  if (options.definitionImport.length === 0) return fail("definitionImport", "must not be empty");
  if (options.bindingImport.length === 0) return fail("bindingImport", "must not be empty");
  const serverImport = options.serverImport ?? "./_generated/server.js";
  if (serverImport.length === 0) return fail("serverImport", "must not be empty");

  const views = entries(definition.views, "view", "views");
  const changes = entries(definition.changes, "change", "changes");
  const projections = entries(definition.projections, "project", "projections");
  const hasReads = views.length > 0;
  const hasWrites = changes.length > 0 || projections.length > 0;
  const imports = [
    `import { ${definitionExport} as syncDefinition } from ${quote(options.definitionImport)};`,
    `import { bind as bindHome${projections.length === 0 ? "" : ", bindProjection as bindProjectionHome"} } from ${quote(options.bindingImport)};`,
    `import * as Schema from "effect/Schema";`,
    `import { decodeWireValue, validateWireValue, type WireValue } from "@signalbox/sync/adapters/lunoraWireValue";`,
    `import { asLunoraSyncError } from "@signalbox/sync/adapters/lunoraHomeWire";`,
    `import { SyncFailure${hasReads ? ", SyncCursor" : ""}, type SyncSchema } from "@signalbox/sync/definition";`,
    `import { ${[
      ...(hasReads ? ["toLunoraReadContext"] : []),
      ...(hasWrites ? ["toLunoraWriteContext"] : []),
    ].join(", ")} } from "@signalbox/sync/adapters/lunoraContext";`,
    `import type { ${[
      ...(hasReads ? ["QueryCtx"] : []),
      ...(hasWrites ? ["MutationCtx"] : []),
    ].join(", ")} } from ${quote(serverImport)};`,
    `import { ${[
      ...(hasReads ? ["query"] : []),
      ...(changes.length > 0 ? ["mutation"] : []),
      ...(projections.length > 0 ? ["internalMutation"] : []),
      "v",
    ].join(", ")} } from ${quote(serverImport)};`,
  ];
  const helpers = [
    `const isSyncFailure = Schema.is(SyncFailure);
const mapSyncFailure = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (error) {
    if (isSyncFailure(error)) throw asLunoraSyncError(error);
    throw error;
  }
};
const decodeInput = <S extends SyncSchema>(schema: S, value: unknown): Promise<S["Type"]> =>
  mapSyncFailure(() => decodeWireValue(schema, value, "invalid_input"));
const validateOutput = <S extends SyncSchema>(schema: S, value: unknown): Promise<WireValue<S>> =>
  mapSyncFailure(() => validateWireValue(schema, value));`,
    ...(hasReads ? [`const readContext = (ctx: QueryCtx) => toLunoraReadContext(ctx);`] : []),
    ...(hasWrites ? [`const writeContext = (ctx: MutationCtx) => toLunoraWriteContext(ctx);`] : []),
  ];
  const emittedViews = views.map(({ name, exportName, operation }) =>
    emitView(
      name,
      exportName,
      inputValidator(operation, `views.${name}.input`),
      viewOutput(operation, `views.${name}.output`),
      !isNeverSchema(operation.output),
      !isNeverSchema(operation.failure),
    ),
  );
  const emittedChanges = changes.map(({ name, exportName, operation }) =>
    emitChange(
      name,
      exportName,
      inputValidator(operation, `changes.${name}.input`),
      writeOutput(operation, `changes.${name}.output`),
    ),
  );
  const emittedProjections = projections.map(({ name, exportName, operation }) =>
    emitProjection(
      name,
      exportName,
      inputValidator(operation, `projections.${name}.input`),
      writeOutput(operation, `projections.${name}.output`),
    ),
  );

  const functions = {
    views: Object.fromEntries(views.map(({ name, exportName }) => [name, exportName])),
    changes: Object.fromEntries(changes.map(({ name, exportName }) => [name, exportName])),
    projections: Object.fromEntries(projections.map(({ name, exportName }) => [name, exportName])),
  } as FunctionNames<Definition>;
  return {
    source: `${imports.join("\n")}\n\n${helpers.join("\n\n")}\n\n${[
      ...emittedViews,
      ...emittedChanges,
      ...emittedProjections,
    ].join("\n\n")}\n`,
    functions,
  };
}
