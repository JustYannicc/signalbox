import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RecoveryEvidence, RecoveryInspection } from "./RecoveryEvidence.ts";

export interface RecoveryDrillEnv {
  readonly SIGNALBOX_STAGE?: string;
  readonly ENVIRONMENT_ID?: string;
  readonly RECOVERY_DRILLS?: string;
}

/** A deploy disables drills again; operators opt one preview in for its disposable threads. */
export const recoveryDrillsEnabled = (env: RecoveryDrillEnv) => {
  const preview = env.SIGNALBOX_STAGE?.match(/^pr-([1-9]\d*)$/);
  return (
    env.RECOVERY_DRILLS === "1" &&
    preview !== undefined &&
    preview !== null &&
    env.ENVIRONMENT_ID === `cloud-preview-${preview[1]}`
  );
};

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Expected = Schema.Struct({
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  runId: Schema.NullOr(Id),
  machineId: Schema.NullOr(Id),
});
const Command = Schema.Struct({
  action: Schema.Literals(["inspect", "enroll", "disable", "reset", "retry-alarm"]),
  id: Id,
  expected: Schema.optionalKey(Expected),
  commandIds: Schema.Array(Id).check(Schema.isMaxLength(20)),
});
const decodeCommand = Schema.decodeUnknownOption(Command);

interface Fault {
  readonly id: string;
  readonly action: "reset" | "retry-alarm";
  readonly incarnation: string;
  readonly before: RecoveryEvidence;
  readonly deliveries: ReadonlyArray<{ readonly isRetry: boolean; readonly retryCount: number }>;
  readonly complete: boolean;
  readonly cancelled?: string;
}

export interface RecoveryDrillState {
  readonly enabled: boolean;
  readonly userId: string;
  readonly faults: ReadonlyArray<Fault>;
}

interface RecoveryDrillHost {
  readonly incarnation: () => Promise<string>;
  readonly load: () => Promise<RecoveryDrillState | undefined>;
  readonly save: (state: RecoveryDrillState) => Promise<void>;
  readonly inspect: (
    userId: string,
    commandIds: ReadonlyArray<string>,
  ) => Promise<RecoveryInspection>;
  readonly exclusive: <A>(work: () => Promise<A>) => Promise<A>;
  readonly rearm: () => Promise<void>;
  readonly reset: () => void;
  readonly arm: () => Promise<void>;
}

const rejection = (error: string) => ({ error });
const matches = (expected: typeof Expected.Type, evidence: RecoveryEvidence) =>
  expected.generation === evidence.lease.generation &&
  expected.machineId === evidence.machine.machineId &&
  expected.runId === evidence.activeRunId;

/** Private service-binding controls. The public Worker never routes requests here. */
export const makeRecoveryDrill = (env: RecoveryDrillEnv, host: RecoveryDrillHost) => {
  let incarnation: Promise<string> | undefined;
  const incarnationOf = () => (incarnation ??= host.incarnation());
  return {
    async command(userId: string, input: unknown) {
      if (!recoveryDrillsEnabled(env)) return rejection("disabled");
      const decoded = decodeCommand(input);
      if (Option.isNone(decoded)) return rejection("invalid_command");
      const command = decoded.value;
      const stored = await host.load();
      if (command.action === "disable") {
        if (stored === undefined || stored.userId !== userId) return rejection("not_enrolled");
        const state = {
          ...stored,
          enabled: false,
          faults: stored.faults.map((fault) =>
            fault.complete ? fault : { ...fault, complete: true, cancelled: "disabled" },
          ),
        };
        await host.save(state);
        await host.rearm();
        return { incarnation: await incarnationOf(), state };
      }
      const evidence = await host.inspect(userId, command.commandIds);
      if (evidence === null) return rejection("not_found");
      if ("error" in evidence) return evidence;
      if (command.action === "enroll") {
        const state = stored ?? { enabled: true, userId, faults: [] };
        await host.save({ ...state, enabled: true });
        return { incarnation: await incarnationOf(), evidence, state: { ...state, enabled: true } };
      }
      if (stored === undefined || stored.userId !== userId) return rejection("not_enrolled");
      if (command.action === "inspect")
        return { incarnation: await incarnationOf(), evidence, state: stored };
      if (!stored.enabled) return rejection("not_enrolled");
      const previous = stored.faults.find((fault) => fault.id === command.id);
      if (previous !== undefined) {
        return previous.action === command.action
          ? { incarnation: await incarnationOf(), evidence, state: stored, replayed: true }
          : rejection("id_conflict");
      }
      if (command.expected === undefined || !matches(command.expected, evidence)) {
        return rejection("stale_target");
      }
      if (stored.faults.length >= 20) return rejection("fault_limit");
      if (stored.faults.some((fault) => !fault.complete)) return rejection("fault_pending");
      const fault: Fault = {
        id: command.id,
        action: command.action,
        incarnation: await incarnationOf(),
        before: evidence,
        deliveries: [],
        complete: command.action === "reset",
      };
      const state = { ...stored, faults: [...stored.faults, fault] };
      if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 1_500_000) {
        return rejection("evidence_limit");
      }
      // The one-shot consumption and pre-fault evidence must survive the reset.
      await host.save(state);
      if (command.action === "reset") host.reset();
      else await host.arm();
      return { incarnation: await incarnationOf(), evidence, state };
    },

    async alarm(
      info: Pick<AlarmInvocationInfo, "isRetry" | "retryCount"> | undefined,
      tick: () => Promise<void>,
    ) {
      if (!recoveryDrillsEnabled(env)) return tick();
      const before = await host.load();
      const pending = before?.enabled
        ? before.faults.find((fault) => fault.action === "retry-alarm" && !fault.complete)
        : undefined;
      if (before === undefined || pending === undefined) return tick();
      await tick();
      await host.exclusive(async () => {
        const state = await host.load();
        const currentFault = state?.faults.find((fault) => fault.id === pending.id);
        if (
          state === undefined ||
          !state.enabled ||
          currentFault === undefined ||
          currentFault.complete
        ) {
          return;
        }
        const first = currentFault.deliveries.length === 0;
        let cancelled: string | undefined;
        if (first) {
          const current = await host.inspect(state.userId, []);
          if (current !== null && "error" in current) cancelled = current.error;
          else if (
            current === null ||
            !matches(
              {
                generation: pending.before.lease.generation,
                runId: pending.before.activeRunId,
                machineId: pending.before.machine.machineId,
              },
              current,
            )
          )
            cancelled = "stale_target";
        }
        const retried =
          !first &&
          info !== undefined &&
          info.isRetry &&
          info.retryCount > currentFault.deliveries[0]!.retryCount;
        if (cancelled === undefined && info === undefined) cancelled = "missing_alarm_metadata";
        if (cancelled === undefined && !first && !retried) cancelled = "not_redelivered";
        const deliveries =
          info === undefined
            ? currentFault.deliveries
            : [...currentFault.deliveries, { isRetry: info.isRetry, retryCount: info.retryCount }];
        await host.save({
          ...state,
          faults: state.faults.map((fault) =>
            fault.id === pending.id
              ? {
                  ...fault,
                  deliveries,
                  complete: !first || cancelled !== undefined,
                  ...(cancelled === undefined ? {} : { cancelled }),
                }
              : fault,
          ),
        });
        // Do not replace this alarm: Cloudflare must retry the failed invocation itself.
        if (first && cancelled === undefined) host.reset();
        await host.rearm();
      });
    },

    async preservesAlarm() {
      if (!recoveryDrillsEnabled(env)) return false;
      const state = await host.load();
      return (
        state?.enabled === true &&
        state.faults.some((fault) => fault.action === "retry-alarm" && !fault.complete)
      );
    },
  };
};
