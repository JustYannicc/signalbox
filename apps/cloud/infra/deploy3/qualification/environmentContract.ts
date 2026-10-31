import * as Schema from "effect/Schema";
import type { ChildWorkerLoaderPort } from "../../../src/computer/WorkerLoaderDispatch.ts";
import { parseDeploy3Name } from "../deadline.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
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
    RUN_ID: Schema.String.check(
      Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu),
    ),
    WORKER_NAME: Schema.String.check(
      Schema.makeFilter((value) => parseDeploy3Name(value)?.role === "workload"),
    ),
    CONFIG_SHA256: Hash,
    BUNDLE_SHA256: Hash,
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

function hasMethods(value: unknown, methods: readonly string[]) {
  return (
    typeof value === "object" &&
    value !== null &&
    methods.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

const Namespace = Schema.declare<DurableObjectNamespace>((value): value is DurableObjectNamespace =>
  hasMethods(value, ["get", "getByName", "idFromName"]),
);
const Loader = Schema.declare<WorkerLoader>((value): value is WorkerLoader =>
  hasMethods(value, ["get", "load"]),
);
const Fetcher = Schema.declare<Fetcher>((value): value is Fetcher => hasMethods(value, ["fetch"]));

type QualifierTailPort = Fetcher & {
  tail(items: TraceItem[]): Promise<void>;
  captureOuter(items: TraceItem[]): Promise<unknown>;
};

export const QualifierRuntimeConfiguration = qualifierConfigurationSchema({
  namespace: () => Namespace,
  loader: Loader,
  commands: Schema.declare<Fetcher & ChildWorkerLoaderPort>(
    (value): value is Fetcher & ChildWorkerLoaderPort => hasMethods(value, ["fetch", "run"]),
  ),
  tail: Schema.declare<QualifierTailPort>((value): value is QualifierTailPort =>
    hasMethods(value, ["fetch", "tail", "captureOuter"]),
  ),
  assets: Fetcher,
});
export type QualifierRuntimeConfiguration = typeof QualifierRuntimeConfiguration.Type;
const decodeRuntime = Schema.decodeUnknownSync(QualifierRuntimeConfiguration);

export function assertQualifierRuntimeConfiguration(value: unknown) {
  decodeRuntime(value);
}

export const QualifierPlannedConfiguration = qualifierConfigurationSchema({
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

export const decodeQualifierPlannedConfiguration = Schema.decodeUnknownSync(
  QualifierPlannedConfiguration,
);
