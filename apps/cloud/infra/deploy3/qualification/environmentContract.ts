import * as Schema from "effect/Schema";
import type { ChildWorkerLoaderPort } from "../../../src/computer/WorkerLoaderDispatch.ts";
import { parseDeploy3Name } from "../deadline.ts";

export const QualifierHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const QualifierRunId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu),
);
export const QualifierWorkerName = Schema.String.check(
  Schema.makeFilter((value) => parseDeploy3Name(value)?.role === "workload"),
);
const ResidentBytes = Schema.String.check(
  Schema.makeFilter((value) => /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value))),
);

// Plan descriptors and live platform objects have different protocols, but must supply the same fields.
function qualifierConfigurationSchema<
  Namespace extends Schema.Top,
  Loader extends Schema.Top,
  Commands extends Schema.Top,
  Tail extends Schema.Top,
  Assets extends Schema.Top,
>(ports: {
  namespace: (resourceId: string, className: string) => Namespace;
  loader: Loader;
  commands: Commands;
  tail: Tail;
  assets: Assets;
}) {
  return Schema.Struct({
    RUN_ID: QualifierRunId,
    WORKER_NAME: QualifierWorkerName,
    CONFIG_SHA256: QualifierHash,
    RESIDENT_BYTE_LIMIT: ResidentBytes,
    OBSERVER_GUARD_ONLY: Schema.optionalKey(Schema.Literal("1")),
    QUALIFIER: ports.namespace("Qualifier", "QualifierProof"),
    CLAUDE_FIXTURES: ports.namespace("ClaudeFixtures", "QualifierClaudeFixtures"),
    HARNESS_RUN_STORE: ports.namespace("RunStore", "QualifierRunStore"),
    HARNESS_FILES_STORE: ports.namespace("FilesStore", "QualifierFilesStore"),
    HARNESS_THREAD_SUPERVISOR: ports.namespace("Supervisor", "QualifierSupervisor"),
    PLACEMENT_STORES: ports.namespace("Placement", "QualifierPlacementStore"),
    PROCESS_EXECUTION_SHARDS: ports.namespace("Shards", "QualifierShard"),
    LOADER: ports.loader,
    PROGRAM_ASSETS: ports.assets,
    QUALIFIER_COMMANDS: ports.commands,
    QUALIFIER_TAIL: ports.tail,
  });
}

export function hasQualifierMethods(value: unknown, methods: readonly string[]) {
  return (
    typeof value === "object" &&
    value !== null &&
    methods.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

const Namespace = Schema.declare<DurableObjectNamespace>((value): value is DurableObjectNamespace =>
  hasQualifierMethods(value, ["get", "getByName", "idFromName"]),
);
const Loader = Schema.declare<WorkerLoader>((value): value is WorkerLoader =>
  hasQualifierMethods(value, ["get", "load"]),
);
const Fetcher = Schema.declare<Fetcher>((value): value is Fetcher =>
  hasQualifierMethods(value, ["fetch"]),
);

type QualifierTailPort = Fetcher & {
  tail(items: TraceItem[]): Promise<void>;
  captureOuter(items: TraceItem[]): Promise<unknown>;
};

export const QualifierShardRuntimeConfiguration = qualifierConfigurationSchema({
  namespace: () => Namespace,
  loader: Loader,
  commands: Schema.declare<Fetcher & ChildWorkerLoaderPort>(
    (value): value is Fetcher & ChildWorkerLoaderPort =>
      hasQualifierMethods(value, ["fetch", "run"]),
  ),
  tail: Schema.declare<QualifierTailPort>((value): value is QualifierTailPort =>
    hasQualifierMethods(value, ["fetch", "tail", "captureOuter"]),
  ),
  assets: Fetcher,
});
export const QualifierRuntimeConfiguration = Schema.Struct({
  ...QualifierShardRuntimeConfiguration.fields,
  BUNDLE_SHA256: QualifierHash,
});
export type QualifierRuntimeConfiguration = typeof QualifierRuntimeConfiguration.Type;
const decodeRuntime = Schema.decodeUnknownSync(QualifierRuntimeConfiguration);

export function assertQualifierRuntimeConfiguration(value: unknown) {
  decodeRuntime(value);
}

export const QualifierShardPlannedConfiguration = qualifierConfigurationSchema({
  namespace: (resourceId, className) =>
    Schema.Struct({
      type: Schema.Literal("durable_object_namespace"),
      resourceId: Schema.Literal(resourceId),
      className: Schema.Literal(className),
    }),
  loader: Schema.Struct({ type: Schema.Literal("worker_loader") }),
  commands: Schema.Struct({
    type: Schema.Literal("service"),
    entrypoint: Schema.Literal("QualifierCommands"),
  }),
  tail: Schema.Struct({
    type: Schema.Literal("service"),
    entrypoint: Schema.Literal("QualifierTail"),
  }),
  assets: Schema.Struct({ type: Schema.Literal("assets") }),
});
export const QualifierPlannedConfiguration = Schema.Struct({
  ...QualifierShardPlannedConfiguration.fields,
  BUNDLE_SHA256: QualifierHash,
});

export const decodeQualifierPlannedConfiguration = Schema.decodeUnknownSync(
  QualifierPlannedConfiguration,
);
