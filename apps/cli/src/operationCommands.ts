import { jsonSchemaOf, type Operation, operations } from "@signalbox/api/catalog";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { Command, Flag } from "effect/cli";

import { callOperation, followOperation } from "./http.ts";
import { asUserErrors } from "./userErrors.ts";
import { resolveTarget } from "./target.ts";

/**
 * One command per public API operation, generated from the catalog: the
 * operation `automations.runs.get` is `signalbox automations runs get`. Each
 * top-level input field is a flag (`--parent-id`). Scalars take their value;
 * anything structured takes JSON. `--input` gives the whole input as JSON, `@file`
 * or `-` for stdin, and flags win over it. Nothing here is written per
 * operation, so a new RPC is a new command.
 */

type FieldKind = "string" | "nullable-string" | "number" | "boolean" | "json";

interface Field {
  readonly property: string;
  readonly flag: string;
  readonly kind: FieldKind;
  readonly required: boolean;
}

type JsonSchemaNode = {
  readonly type?: unknown;
  readonly enum?: unknown;
  readonly const?: unknown;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly description?: unknown;
};

const kindOf = (node: JsonSchemaNode): FieldKind => {
  if (node.type === "string" || typeof node.const === "string" || Array.isArray(node.enum)) {
    return "string";
  }
  if (node.type === "integer" || node.type === "number") return "number";
  if (node.type === "boolean") return "boolean";
  // A union of string literals is a choice like any other string; `null` is spelled out.
  if (node.anyOf?.every((member) => member.type === "null" || kindOf(member) === "string")) {
    return node.anyOf.some((member) => member.type === "null") ? "nullable-string" : "string";
  }
  return "json";
};

/** Flags kept for the CLI itself; an input field with one of these names goes through `--input`. */
const RESERVED = new Set(["input", "follow", "url", "help", "version"]);

const fieldsOf = (operation: Operation): ReadonlyArray<Field> => {
  const { schema } = jsonSchemaOf(operation.input);
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return (
    Object.entries(properties)
      .map(([property, node]) => ({
        property,
        flag: Str.camelToSnake(property).replaceAll("_", "-"),
        kind: kindOf(node),
        required: required.has(property),
      }))
      .filter((field) => !RESERVED.has(field.flag))
      // The CLI compiles `source` into `compiled` itself (`localCompile.ts`).
      .filter((field) => !(operation.compiles && field.property === "compiled"))
  );
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** `--input`'s value: JSON, `@path` for a file, or `-` for stdin. */
const readInput = (raw: string) =>
  Effect.gen(function* () {
    if (raw === "-") {
      const stdio = yield* Stdio.Stdio;
      const text = yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString);
      return yield* decodeJson(text);
    }
    if (raw.startsWith("@")) {
      const fs = yield* FileSystem.FileSystem;
      return yield* decodeJson(yield* fs.readFileString(raw.slice(1)));
    }
    return yield* decodeJson(raw);
  });

const valueOf = (field: Field, raw: string | boolean) =>
  typeof raw === "boolean" || field.kind === "string"
    ? Effect.succeed(raw)
    : field.kind === "nullable-string"
      ? Effect.succeed(raw === "null" ? null : raw)
      : field.kind === "number"
        ? Effect.succeed(Number(raw))
        : decodeJson(raw);

const flagFor = (field: Field) => {
  const described = (flag: Flag.Flag<Option.Option<string | boolean>>) =>
    Flag.withDescription(
      flag,
      [
        field.required ? "Required. " : "",
        field.kind === "json" ? "JSON. " : "",
        field.kind === "nullable-string" ? "`null` for none. " : "",
        `Sets \`${field.property}\`.`,
      ].join(""),
    );
  return described(
    field.kind === "boolean"
      ? Flag.optional(Flag.Boolean(field.flag))
      : Flag.optional(Flag.String(field.flag)),
  );
};

const describe = (operation: Operation) =>
  [
    operation.summary ?? `Calls ${operation.name}.`,
    operation.stream === undefined ? "" : " Add --follow to keep streaming.",
    operation.humanOnly ? " Only you can do this; agents can't." : "",
    operation.destructive ? " Deletes something." : "",
  ].join("");

const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

/** The command that calls `operation`, named `name` (its last path segment). */
const leafCommand = (operation: Operation, name: string) => {
  const fields = fieldsOf(operation);
  const flags = {
    input: Flag.optional(Flag.String("input")).pipe(
      Flag.withDescription("The whole input: JSON, @file, or - for stdin."),
    ),
    url: Flag.optional(Flag.String("url")).pipe(
      Flag.withDescription("Which Signalbox, if not the one you signed in to."),
    ),
    ...(operation.stream === undefined
      ? {}
      : {
          follow: Flag.Boolean("follow").pipe(
            Flag.withDefault(false),
            Flag.withDescription("Print every update as a JSON line until interrupted."),
          ),
        }),
    ...Object.fromEntries(fields.map((field) => [field.property, flagFor(field)])),
  };
  return Command.make(name, flags, (values) =>
    Effect.gen(function* () {
      const given = values as Record<string, unknown>;
      const base = Option.isSome(values.input) ? yield* readInput(values.input.value) : {};
      const input: Record<string, unknown> =
        typeof base === "object" && base !== null ? { ...base } : {};
      for (const field of fields) {
        const raw = given[field.property] as Option.Option<string | boolean>;
        if (Option.isSome(raw)) input[field.property] = yield* valueOf(field, raw.value);
      }
      const target = yield* resolveTarget(values.url);
      if (given.follow === true) {
        return yield* followOperation(target, operation.name, input).pipe(
          Stream.runForEach(Console.log),
        );
      }
      return yield* print(yield* callOperation(target, operation.name, input));
    }).pipe(asUserErrors),
  ).pipe(Command.withDescription(describe(operation)));
};

/** Commands of every shape share one tree; the root says what they need and fail with (`cli.ts`). */
type AnyCommand = Command.Command.Any;

interface Node {
  /** The node's own command: an operation's, or a hand-written one like `login`. */
  command?: AnyCommand;
  readonly children: Map<string, Node>;
}

const segmentName = (segment: string) => Str.camelToSnake(segment).replaceAll("_", "-");

const buildCommand = (name: string, node: Node): AnyCommand => {
  const children = [...node.children.entries()].map(([child, sub]) => buildCommand(child, sub));
  const base: AnyCommand =
    node.command ??
    Command.make(name).pipe(Command.withDescription(`${[...node.children.keys()].join(", ")}.`));
  const [first, ...rest] = children;
  return first === undefined ? base : Command.withSubcommands(base, [first, ...rest]);
};

const place = (root: Node, path: ReadonlyArray<string>, command: AnyCommand) => {
  let node = root;
  for (const segment of path) {
    const next = node.children.get(segment) ?? { children: new Map() };
    node.children.set(segment, next);
    node = next;
  }
  node.command = command;
};

/** Every operation's command path: `automations.runs.get` is `automations runs get`. */
export const commandPathOf = (operation: Operation): ReadonlyArray<string> =>
  operation.name.split(".").map(segmentName);

/** The generated commands, grouped by resource, plus `extra` hand-written ones at their paths. */
export const operationCommands = (
  extra: ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly command: AnyCommand }> = [],
): ReadonlyArray<AnyCommand> => {
  const root: Node = { children: new Map() };
  for (const operation of operations) {
    const path = commandPathOf(operation);
    place(root, path, leafCommand(operation, path.at(-1)!));
  }
  for (const entry of extra) place(root, entry.path, entry.command);
  return [...root.children.entries()].map(([name, node]) => buildCommand(name, node));
};
