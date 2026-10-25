import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const STEPS = [
  "connect",
  "create",
  "private",
  "workload",
  "hibernate",
  "wake",
  "snapshot",
  "fork",
  "fork-private",
  "clone-wait",
  "clone-config",
  "clone-ready",
  "usage",
  "release",
  "archive",
] as const;
export type Step = (typeof STEPS)[number];

const Timing = Schema.Struct({
  step: Schema.Literals(STEPS),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  calls: Schema.Number,
  activeMs: Schema.Number,
});
const Owned = Schema.Struct({
  source: Schema.Boolean,
  clone: Schema.Boolean,
  snapshot: Schema.Boolean,
});
export type Owned = typeof Owned.Type;
const Usage = Schema.Struct({
  costMicro: Schema.Number,
  currency: Schema.Literals(["eur", "usd"]),
  complete: Schema.Boolean,
});
export type Usage = typeof Usage.Type;
export const Record = Schema.Struct({
  usage: Schema.NullOr(Usage),
  owned: Owned,
  owner: Schema.String,
  startedAt: Schema.Number,
  deadline: Schema.Number,
  index: Schema.Number,
  attempted: Schema.Boolean,
  cleanup: Schema.Boolean,
  done: Schema.Boolean,
  failure: Schema.NullOr(Schema.Literals(["provider", "deadline", "archived"])),
  timings: Schema.Array(Timing),
  metrics: Schema.Record(Schema.String, Schema.Number),
});
export type Record = typeof Record.Type;
export const decodeRecord = Schema.decodeUnknownSync(Record);

export interface ProbeConfig {
  readonly owner: string;
  readonly lifetimeMs: number;
}

export class ProbeStore extends Context.Service<
  ProbeStore,
  {
    readonly load: () => Promise<unknown>;
    readonly save: (record: Record) => Promise<void>;
    readonly now: () => number;
  }
>()("@signalbox/cloud/boxdSpike/Probe/ProbeStore") {}

export class ProbeApi extends Context.Service<
  ProbeApi,
  {
    /** False means accepted but not yet observed. Attempted prevents reissuing create/fork/snapshot. */
    readonly step: (
      step: Step,
      attempted: boolean,
      deadline: number,
    ) => Promise<{
      ready: boolean;
      metrics?: Readonly<globalThis.Record<string, number>>;
      usage?: Usage;
    }>;
    readonly cleanup: (owned: Owned) => Promise<boolean>;
  }
>()("@signalbox/cloud/boxdSpike/Probe/ProbeApi") {}

export class ProbeError extends Schema.TaggedError<ProbeError>()("BoxdProbeError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Boxd spike storage unavailable.";
  }
}

export class Probe extends Context.Service<
  Probe,
  {
    readonly status: Effect.Effect<Record | null, ProbeError>;
    readonly advance: (archive?: boolean) => Effect.Effect<Record, ProbeError>;
    readonly sweep: Effect.Effect<Record | null, ProbeError>;
  }
>()("@signalbox/cloud/boxdSpike/Probe") {}

export const layer = (config: ProbeConfig) =>
  Layer.effect(
    Probe,
    Effect.gen(function* () {
      const store = yield* ProbeStore;
      const api = yield* ProbeApi;
      const io = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => new ProbeError({ cause }) });
      const status = io(async () => {
        const saved = await store.load();
        return saved === undefined ? null : decodeRecord(saved);
      });
      const save = (record: Record) => io(() => store.save(record));

      const clean = (record: Record) =>
        Effect.gen(function* () {
          const done = yield* Effect.promise(() => api.cleanup(record.owned)).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          );
          const next = { ...record, done };
          yield* save(next);
          return next;
        });

      const advance = (archive = false) =>
        Effect.gen(function* () {
          let record = (yield* status) ?? {
            usage: null,
            owned: { source: false, clone: false, snapshot: false },
            owner: config.owner,
            startedAt: store.now(),
            deadline: store.now() + config.lifetimeMs,
            index: 0,
            attempted: false,
            cleanup: false,
            done: false,
            failure: null,
            timings: [],
            metrics: {},
          };
          if (record.owner !== config.owner)
            return yield* Effect.fail(new ProbeError({ cause: "owner mismatch" }));
          if (archive || (!record.done && store.now() >= record.deadline)) {
            record = {
              ...record,
              cleanup: true,
              failure: record.failure ?? (archive ? "archived" : "deadline"),
            };
            yield* save(record);
          }
          if (record.cleanup) return yield* clean(record);
          if (record.done) return record;
          const step = STEPS[record.index];
          if (step === undefined) return record;
          const timing = record.timings.find((t) => t.step === step) ?? {
            step,
            startedAt: store.now(),
            finishedAt: null,
            calls: 0,
            activeMs: 0,
          };
          const attempted = record.attempted;
          record = {
            ...record,
            attempted: true,
            owned: {
              source: record.owned.source || step === "create",
              clone: record.owned.clone || step === "fork",
              snapshot: record.owned.snapshot || step === "snapshot",
            },
            timings: [
              ...record.timings.filter((t) => t.step !== step),
              { ...timing, calls: timing.calls + 1 },
            ],
          };
          // Persist before any side effect. A lost create response becomes lookup-only on resume.
          yield* save(record);
          const callStartedAt = store.now();
          const result = yield* Effect.tryPromise({
            try: () => api.step(step, attempted, record.deadline),
            catch: () => "provider" as const,
          }).pipe(Effect.result);
          record = {
            ...record,
            timings: record.timings.map((t) =>
              t.step === step ? { ...t, activeMs: t.activeMs + store.now() - callStartedAt } : t,
            ),
          };
          if (result._tag === "Failure") {
            record = { ...record, failure: "provider", cleanup: true };
            yield* save(record);
            return yield* clean(record);
          }
          if (
            (step === "wake" &&
              result.success.ready &&
              (record.metrics.sourcePid === undefined ||
                result.success.metrics?.wakePid !== record.metrics.sourcePid)) ||
            (step === "clone-wait" &&
              result.success.ready &&
              (record.metrics.sourcePid === undefined ||
                result.success.metrics?.clonePid !== record.metrics.sourcePid))
          ) {
            record = { ...record, failure: "provider", cleanup: true };
            yield* save(record);
            return yield* clean(record);
          }
          record = {
            ...record,
            usage: result.success.usage ?? record.usage,
            metrics: { ...record.metrics, ...result.success.metrics },
          };
          if (result.success.ready) {
            record = {
              ...record,
              index: record.index + 1,
              attempted: false,
              done: step === "archive",
              cleanup: step === "archive",
              timings: record.timings.map((t) =>
                t.step === step ? { ...t, finishedAt: store.now() } : t,
              ),
            };
          }
          yield* save(record);
          return record;
        });

      // Sweep never starts a run. Keep checking owned names after cleanup for late provider responses.
      const sweep = Effect.gen(function* () {
        const record = yield* status;
        if (!record) return null;
        if (record.cleanup) return yield* clean(record);
        if (store.now() >= record.deadline) return yield* advance();
        return record;
      });
      return Probe.of({ status, advance, sweep });
    }),
  );
