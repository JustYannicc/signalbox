import { CommandId, OrchestrationV2Command, WsRpcGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as RpcSchema from "effect/rpc/RpcSchema";

import { COMMAND_REACH } from "./commandReach.ts";
import type {
  CommandType,
  DerivedReach,
  ExemptKind,
  Reach,
  StreamRead,
  WsRpcMethod,
} from "./reach.ts";
import { SIGNALBOX_RPC_REACH } from "./signalboxReach.ts";
import { UPSTREAM_RPC_REACH } from "./upstreamReach.ts";

/**
 * The public API's operations, derived from the contracts' RPC group and the
 * reach maps. The cloud serves them, and the CLI and MCP tools are generated
 * from them, so this list is the one place their surface is decided.
 */

/** Every RPC's reach. Adding an RPC to `WsRpcGroup` without an entry is a type error. */
export const RPC_REACH = {
  ...UPSTREAM_RPC_REACH,
  ...SIGNALBOX_RPC_REACH,
} as const satisfies Record<WsRpcMethod, Reach>;

export { COMMAND_REACH };

/** The version in the API's paths; it changes only when an operation breaks its callers. */
export const API_VERSION = "v1";

/** A contract schema: no services to decode or encode, like every RPC schema. */
export type WireSchema = Schema.Codec<unknown, unknown>;

/** Contract schemas need no services; the RPC group's types just don't say so. */
const wire = (schema: Schema.Top): WireSchema => schema as WireSchema;

export interface Operation {
  /** `<resource>.<verb>`, unique. The CLI's command path and the MCP name. */
  readonly name: string;
  readonly rpc: WsRpcMethod;
  /** Set for `dispatchCommand` operations: the command's `type`. */
  readonly command: CommandType | undefined;
  readonly access: DerivedReach["access"];
  /** Set for streaming RPCs: which item a one-shot call answers with. */
  readonly stream: StreamRead | undefined;
  readonly humanOnly: boolean;
  readonly destructive: boolean;
  readonly agentCallable: boolean;
  /** The caller compiles its `source` into `compiled` before sending (`DerivedReach.compiles`). */
  readonly compiles: boolean;
  readonly summary: string | undefined;
  readonly input: WireSchema;
  /** A stream's item schema, not the stream's. */
  readonly output: WireSchema;
  /** Everything a call can fail with: the RPC's, its stream's and its middleware's errors. */
  readonly error: WireSchema;
}

export interface Exemption {
  readonly rpc: WsRpcMethod;
  readonly command: CommandType | undefined;
  readonly kind: ExemptKind;
  readonly reason: string;
}

const TAG_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["signalbox.", ""],
  ["orchestration.", "threads."],
  ["accountPool.", "pools."],
];

/** `signalbox.folders.create` → `folders.create`, `subscribeVcsStatus` → `vcsStatus.subscribe`. */
export const defaultRpcName = (tag: string): string => {
  const subscription = /^subscribe([A-Z]\w*)$/.exec(tag);
  if (subscription) return `${Str.uncapitalize(subscription[1]!)}.subscribe`;
  const prefix = TAG_PREFIXES.find(([from]) => tag.startsWith(from));
  const name = prefix ? `${prefix[1]}${tag.slice(prefix[0].length)}` : tag;
  return name.split(".").map(Str.camelCase).join(".");
};

/** `thread.archive` → `threads.archive`, `queued-run.cancel` → `threads.queuedRun.cancel`. */
export const defaultCommandName = (type: string): string =>
  `threads.${type.replace(/^thread\./, "")}`.split(".").map(Str.camelCase).join(".");

/** The command as a caller writes it: no `type`, and `commandId` optional. */
const commandInput = (type: CommandType): Schema.Top => {
  const members = OrchestrationV2Command.members.filter(
    (member) => member.fields.type.literal === type,
  );
  // Without `type`, two members of one command would have nothing to tell them apart by.
  if (members.length !== 1) throw new Error(`Command ${type} has ${members.length} schemas.`);
  const { type: _type, commandId: _commandId, ...fields } = members[0]!.fields;
  return Schema.Struct({ ...fields, commandId: Schema.optionalKey(CommandId) });
};

/** Like `Rpc.exitSchema`'s failures, without the `Never`s of RPCs that only fail in their stream. */
const errorOf = (rpc: {
  readonly errorSchema: Schema.Top;
  readonly successSchema: Schema.Top;
  readonly middlewares: ReadonlySet<{ readonly error: Schema.Top }>;
}): Schema.Top => {
  const failures = new Set<Schema.Top>([rpc.errorSchema]);
  if (RpcSchema.isStreamSchema(rpc.successSchema)) failures.add(rpc.successSchema.error);
  for (const middleware of rpc.middlewares) failures.add(middleware.error);
  const present = [...failures].filter((schema) => schema.ast._tag !== "Never");
  return present.length === 1 ? present[0]! : Schema.Union(present);
};

const operationOf = (
  reach: DerivedReach,
  shape: Pick<Operation, "name" | "rpc" | "command" | "stream" | "input" | "output" | "error">,
): Operation => ({
  ...shape,
  access: reach.access,
  humanOnly: reach.humanOnly === true,
  destructive: reach.destructive === true,
  agentCallable:
    reach.humanOnly !== true && (reach.destructive !== true || reach.agentCallable === true),
  compiles: reach.compiles === true,
  summary: reach.summary,
});

const exemptionOf = (
  reach: { readonly kind: ExemptKind; readonly reason: string },
  rpc: WsRpcMethod,
  command?: CommandType,
): Exemption => ({ rpc, command, kind: reach.kind, reason: reach.reason });

const derive = () => {
  const operations: Array<Operation> = [];
  const exemptions: Array<Exemption> = [];
  for (const [tag, rpc] of WsRpcGroup.requests) {
    const rpcTag = tag as WsRpcMethod;
    const reach: Reach | undefined = RPC_REACH[rpcTag];
    if (reach === undefined) throw new Error(`RPC ${tag} has no entry in RPC_REACH.`);
    if (reach._tag === "exempt") {
      exemptions.push(exemptionOf(reach, rpcTag));
      continue;
    }
    const error = errorOf(rpc);
    if (reach._tag === "per-command") {
      for (const [type, commandReach] of Object.entries(COMMAND_REACH) as Array<
        [CommandType, (typeof COMMAND_REACH)[CommandType]]
      >) {
        if (commandReach._tag === "exempt") {
          exemptions.push(exemptionOf(commandReach, rpcTag, type));
          continue;
        }
        operations.push(
          operationOf(commandReach, {
            name: commandReach.name ?? defaultCommandName(type),
            rpc: rpcTag,
            command: type,
            stream: undefined,
            input: wire(commandInput(type)),
            output: wire(rpc.successSchema),
            error: wire(error),
          }),
        );
      }
      continue;
    }
    const success = rpc.successSchema;
    const isStream = RpcSchema.isStreamSchema(success);
    operations.push(
      operationOf(reach, {
        name: reach.name ?? defaultRpcName(tag),
        rpc: rpcTag,
        command: undefined,
        stream: isStream
          ? (reach.stream ?? (reach.access === "read" ? "snapshot" : "final"))
          : undefined,
        input: wire(rpc.payloadSchema),
        output: wire(isStream ? success.success : success),
        error: wire(error),
      }),
    );
  }
  operations.sort((a, b) => a.name.localeCompare(b.name));
  return { operations, exemptions };
};

const derived = derive();

export const operations: ReadonlyArray<Operation> = derived.operations;
export const exemptions: ReadonlyArray<Exemption> = derived.exemptions;

const byName = new Map(operations.map((operation) => [operation.name, operation]));

export const findOperation = (name: string): Operation | undefined => byName.get(name);

type JsonSchemaDocument = ReturnType<typeof Schema.toJsonSchemaDocument>;

const jsonSchemas = new WeakMap<Schema.Top, JsonSchemaDocument>();

/** The document with definition `name` as its root, dropping it from `definitions` unless something still refers to it. */
const inlineRoot = (document: JsonSchemaDocument, name: string): JsonSchemaDocument => {
  const { [name]: root, ...rest } = document.definitions;
  const stillReferenced = JSON.stringify([root, rest]).includes(`"#/$defs/${name}"`);
  return {
    ...document,
    schema: root!,
    definitions: stillReferenced ? document.definitions : rest,
  };
};

const isEmptyStruct = (schema: Schema.Top) =>
  schema.ast._tag === "Objects" &&
  schema.ast.propertySignatures.length === 0 &&
  schema.ast.indexSignatures.length === 0;

/**
 * The JSON Schema of what goes over the wire for `schema`, as the API, CLI and
 * MCP describe it. A root `$ref` is inlined and an empty struct reads as an
 * empty object, so every input's root is an object a tool can take.
 */
export const jsonSchemaOf = (schema: Schema.Top): JsonSchemaDocument => {
  const cached = jsonSchemas.get(schema);
  if (cached) return cached;
  const document = Schema.toJsonSchemaDocument(schema);
  const root = document.schema;
  const ref = typeof root.$ref === "string" ? /^#\/\$defs\/(.+)$/.exec(root.$ref) : null;
  const resolved: JsonSchemaDocument = isEmptyStruct(schema)
    ? { ...document, schema: { type: "object", properties: {}, additionalProperties: false } }
    : ref && document.definitions[ref[1]!]
      ? inlineRoot(document, ref[1]!)
      : document;
  jsonSchemas.set(schema, resolved);
  return resolved;
};
