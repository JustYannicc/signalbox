import type {
  RunnerItem,
  RunnerTurn,
  ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2ThreadSnapshot,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { OrchestrationV2ProviderSession } from "@t3tools/contracts";
import { ReleaseModuleOmittedFailure } from "@t3tools/contracts/harnessReleaseOmission";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessRelease } from "./HarnessRelease.ts";
import type { HarnessProcessStartup } from "./HarnessProcessLifetime.ts";
import type { Computer } from "../computer/Computer.ts";
import type { HarnessHookCallback } from "../hooks/HarnessHooks.ts";
import type { FileCommitReceipt } from "../kernel/FilePersistencePorts.ts";

export type { HarnessRelease };

/** Session files and workspace files are saved together before this checkpoint is returned. */
export interface HarnessCheckpoint {
  readonly release: HarnessRelease;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly snapshot: ProviderAdapterV2ThreadSnapshot;
  readonly revision: FileCommitReceipt;
}

export type HarnessControl = Extract<
  ThreadMessage,
  { readonly type: "steer" | "interrupt" | "runtime-request.respond" }
>;

const errorEnvelopeTag = "~signalbox/HarnessError/Error/v1";
const aggregateErrorEnvelopeTag = "~signalbox/HarnessError/AggregateError/v1";

function makeErrorSchema(causeValue: Schema.Codec<unknown, unknown, never, never>) {
  const wireSchema = Schema.Struct({
    _tag: Schema.Literal(errorEnvelopeTag),
    name: Schema.String,
    message: Schema.String,
    stack: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(causeValue),
  });
  return wireSchema.pipe(
    Schema.decodeTo(Schema.instanceOf(Error), {
      decode: SchemaGetter.transform<Error, typeof wireSchema.Type>((value) => {
        const fields = value;
        const error =
          fields.cause === undefined
            ? new Error(fields.message)
            : new Error(fields.message, { cause: fields.cause });
        error.name = fields.name;
        if (fields.stack !== undefined) error.stack = fields.stack;
        return error;
      }),
      encode: SchemaGetter.transform<typeof wireSchema.Type, Error>((error) => ({
        _tag: errorEnvelopeTag,
        name: error.name,
        message: error.message,
        ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
        ...(error.cause === undefined ? {} : { cause: error.cause }),
      })),
    }),
  );
}

function makeAggregateErrorSchema(causeValue: Schema.Codec<unknown, unknown, never, never>) {
  const wireSchema = Schema.Struct({
    _tag: Schema.Literal(aggregateErrorEnvelopeTag),
    name: Schema.String,
    message: Schema.String,
    stack: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(causeValue),
    errors: Schema.Array(causeValue),
  });
  return wireSchema.pipe(
    Schema.decodeTo(Schema.instanceOf(AggregateError), {
      decode: SchemaGetter.transform<AggregateError, typeof wireSchema.Type>((value) => {
        const fields = value;
        const error =
          fields.cause === undefined
            ? new AggregateError(fields.errors, fields.message)
            : new AggregateError(fields.errors, fields.message, { cause: fields.cause });
        error.name = fields.name;
        if (fields.stack !== undefined) error.stack = fields.stack;
        return error;
      }),
      encode: SchemaGetter.transform<typeof wireSchema.Type, AggregateError>((error) => ({
        _tag: aggregateErrorEnvelopeTag,
        name: error.name,
        message: error.message,
        ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
        ...(error.cause === undefined ? {} : { cause: error.cause }),
        errors: Array.from(error.errors),
      })),
    }),
  );
}

function nestedHarnessErrorSchema() {
  return Schema.suspend(() => HarnessError);
}

const harnessCauseSchema: Schema.Codec<unknown, unknown, never, never> = Schema.suspend(
  (): Schema.Codec<unknown, unknown, never, never> => {
    const effectCauseSchema = Schema.Cause(harnessCauseSchema, harnessCauseSchema);
    return Schema.Union([
      effectCauseSchema,
      nestedHarnessErrorSchema(),
      ReleaseModuleOmittedFailure,
      makeAggregateErrorSchema(harnessCauseSchema),
      makeErrorSchema(harnessCauseSchema),
      Schema.Defect(),
    ]);
  },
);

const harnessProcessStartupSchema = Schema.Struct({
  bootstrap: Schema.NullOr(
    Schema.Struct({
      bytes: Schema.Number,
      state: Schema.Literals(["pending", "written", "failed"]),
    }),
  ),
  wasi: Schema.Literals(["not-started", "running", "returned", "failed"]),
  exit: Schema.NullOr(
    Schema.Struct({
      exitCode: Schema.Number,
      signal: Schema.Number,
      coreDumped: Schema.Boolean,
    }),
  ),
}) satisfies Schema.Codec<Omit<HarnessProcessStartup, "failure">, unknown, never, never>;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  operation: Schema.Literals(["open", "turn", "control", "export", "events", "dispose", "journal"]),
  message: Schema.String,
  cause: Schema.optionalKey(harnessCauseSchema),
  nativeStartup: Schema.optionalKey(harnessProcessStartupSchema),
}) {}

export interface HarnessOpenInput {
  readonly loadedRelease?: LoadedHarnessRelease;
  readonly release: HarnessRelease;
  readonly session: ProviderAdapterV2OpenSessionInput;
  readonly computer: Computer;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly hooks?: HarnessHookCallback;
  readonly checkpoint?: HarnessCheckpoint;
}

export interface HarnessSession {
  readonly release: HarnessRelease;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly events: Stream.Stream<RunnerItem, HarnessError>;
  readonly turn: (input: RunnerTurn) => Effect.Effect<void, HarnessError>;
  readonly control: (input: HarnessControl) => Effect.Effect<void, HarnessError>;
  readonly export: () => Effect.Effect<HarnessCheckpoint, HarnessError>;
  readonly dispose: Effect.Effect<void, HarnessError>;
}

/** Hosts differ only at construction. A running session has no placement or fallback setting. */
export interface Harness {
  readonly open: (
    input: HarnessOpenInput,
  ) => Effect.Effect<HarnessSession, HarnessError, Scope.Scope>;
}
