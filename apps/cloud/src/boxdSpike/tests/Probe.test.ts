import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Probe from "../Probe.ts";

const fixture = (step: Probe.ProbeApi["Service"]["step"] = async () => ({ ready: true })) => {
  let record: Probe.Record | undefined;
  let now = 1000;
  const cleanups: Probe.Owned[] = [];
  const layers = Probe.layer({ owner: "test", lifetimeMs: 900_000 }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(Probe.ProbeStore, {
          load: async () => record,
          save: async (value) => {
            record = structuredClone(value);
          },
          now: () => now,
        }),
        Layer.succeed(Probe.ProbeApi, {
          step,
          cleanup: async (owned) => {
            cleanups.push(owned);
            return true;
          },
        }),
      ),
    ),
  );
  const advance = (archive = false) =>
    Effect.flatMap(Probe.Probe, (service) => service.advance(archive)).pipe(Effect.provide(layers));
  const sweep = Effect.flatMap(Probe.Probe, (service) => service.sweep).pipe(
    Effect.provide(layers),
  );
  return {
    advance,
    sweep,
    record: () => record,
    expire: () => {
      now += 900_001;
    },
    cleanups,
  };
};

describe("resumable lifecycle", () => {
  it.effect(
    "persists intent before allocation and runs privacy, clone and release gates in order",
    () =>
      Effect.gen(function* () {
        const calls: Probe.Step[] = [];
        const f = fixture(async (step) => {
          expect(f.record()?.attempted).toBe(true);
          calls.push(step);
          return {
            ready: true,
            metrics:
              step === "workload"
                ? { sourcePid: 42 }
                : step === "wake"
                  ? { wakePid: 42 }
                  : step === "clone-wait"
                    ? { clonePid: 42, cloneLeaseCleared: 1 }
                    : {},
          };
        });
        for (const _ of Probe.STEPS) yield* f.advance();
        expect(calls).toEqual(Probe.STEPS);
        expect(f.record()?.done).toBe(true);
        expect(f.record()?.metrics).toEqual({
          sourcePid: 42,
          wakePid: 42,
          clonePid: 42,
          cloneLeaseCleared: 1,
        });
        expect(f.record()?.timings.every((t) => t.finishedAt !== null)).toBe(true);
        yield* f.advance();
        expect(calls).toEqual(Probe.STEPS);
      }),
  );

  it.effect("resumes a pending create through lookup instead of allocation", () =>
    Effect.gen(function* () {
      const attempts: boolean[] = [];
      const f = fixture(async (step, attempted) => {
        if (step === "create") {
          attempts.push(attempted);
          return { ready: attempted };
        }
        return { ready: true };
      });
      yield* f.advance();
      yield* f.advance();
      expect(f.record()?.index).toBe(1);
      yield* f.advance();
      expect(attempts).toEqual([false, true]);
      expect(f.record()?.index).toBe(2);
      expect(f.record()?.timings.find((t) => t.step === "create")?.calls).toBe(2);
    }),
  );

  it.effect(
    "sweeps after a provider failure without exposing the error or claiming unattempted names",
    () =>
      Effect.gen(function* () {
        const f = fixture(async () => {
          throw new Error("JWT raw-provider-secret");
        });
        const record = yield* f.advance();
        expect(record.failure).toBe("provider");
        expect(record.cleanup).toBe(true);
        expect(JSON.stringify(record)).not.toContain("raw-provider-secret");
        expect(f.cleanups).toEqual([{ source: false, clone: false, snapshot: false }]);
        yield* f.sweep;
        expect(f.cleanups).toHaveLength(2);
      }),
  );

  it.effect("a deadline prevents further work, and sweep never creates a run", () =>
    Effect.gen(function* () {
      let calls = 0;
      const f = fixture(async () => {
        calls++;
        return { ready: true };
      });
      expect(yield* f.sweep).toBeNull();
      expect(calls).toBe(0);
      yield* f.advance();
      f.expire();
      expect((yield* f.sweep)?.failure).toBe("deadline");
      expect(calls).toBe(1);
      expect(f.cleanups).toHaveLength(1);
    }),
  );

  it.effect("archive invokes destroy while a run is waiting", () =>
    Effect.gen(function* () {
      const f = fixture(async () => ({ ready: false }));
      yield* f.advance();
      const result = yield* f.advance(true);
      expect(result.failure).toBe("archived");
      expect(result.done).toBe(true);
      expect(f.cleanups).toHaveLength(1);
    }),
  );

  it.effect("a cold restart after wake fails memory continuity and cleans up", () =>
    Effect.gen(function* () {
      const f = fixture(async (step) => ({
        ready: true,
        metrics: step === "workload" ? { sourcePid: 42 } : step === "wake" ? { wakePid: 99 } : {},
      }));
      for (let i = 0; i <= Probe.STEPS.indexOf("wake"); i++) yield* f.advance();
      expect(f.record()?.failure).toBe("provider");
      expect(f.cleanups).toEqual([{ source: true, clone: false, snapshot: false }]);
    }),
  );
});
