/**
 * Replays `workload.turn.completed` events against machine price tables:
 * one machine per thread that wakes for a turn and stops after an idle tail.
 * The idle tail is simulated from turn timestamps, so any tail can be priced
 * from the same events (#116).
 */
import * as DateTime from "effect/DateTime";

import type { MachinePrice } from "./workload-prices.ts";

export interface ReplayTurn {
  /** PostHog distinct id: who the turn belongs to, for user-days. */
  readonly userId: string;
  readonly threadId: string;
  readonly endedAtMs: number;
  readonly durationSeconds: number;
  /** Wall-clock seconds of the turn's shell commands, all categories. */
  readonly commandSeconds: number;
  /** Measured CPU of the provider process tree, when the server sampled it. */
  readonly cpuSeconds: number | undefined;
}

export interface ReplayRow {
  readonly idleTailSeconds: number;
  readonly awakeHours: number;
  readonly wakes: number;
  readonly cpuHours: number;
  /** Price id → dollars per active user-day. */
  readonly costPerUserDay: ReadonlyMap<string, number>;
}

export interface Replay {
  readonly turns: number;
  readonly userDays: number;
  readonly measuredCpuTurns: number;
  readonly rows: ReadonlyArray<ReplayRow>;
}

/** How local usage maps to a cloud vCPU. Local CPU runs about twice as fast. */
export const CPU_MODEL = {
  cloudSlowdown: 2,
  // Without a measurement: commands use 1.5 vCPU, the harness 5% of one.
  assumedCommandVcpu: 1.5,
  assumedHarnessVcpu: 0.05,
};

// Longer runs are stuck or waiting on a person, not working.
const MAX_TURN_SECONDS = 6 * 3600;

/**
 * Measured CPU is a lower bound: samples 5 s apart miss commands that start
 * and exit between them. Compare `measuredCpuTurns` before trusting it.
 */
export function cloudCpuSeconds(turn: ReplayTurn): number {
  if (turn.cpuSeconds !== undefined) return turn.cpuSeconds * CPU_MODEL.cloudSlowdown;
  return (
    turn.durationSeconds * CPU_MODEL.assumedHarnessVcpu +
    turn.commandSeconds * CPU_MODEL.cloudSlowdown * CPU_MODEL.assumedCommandVcpu
  );
}

interface TimedTurn {
  readonly turn: ReplayTurn;
  readonly start: number;
  readonly end: number;
}

function simulate(threads: ReadonlyArray<ReadonlyArray<TimedTurn>>, tailSeconds: number) {
  let awakeSeconds = 0;
  let wakes = 0;
  let cpuSeconds = 0;
  for (const turns of threads) {
    turns.forEach((current, index) => {
      awakeSeconds += current.end - current.start;
      cpuSeconds += cloudCpuSeconds(current.turn);
      const previous = turns[index - 1];
      if (previous === undefined || current.start - previous.end > tailSeconds) wakes += 1;
      const next = turns[index + 1];
      const gap = next === undefined ? Infinity : next.start - current.end;
      // A negative gap (overlapping turns) nets the overlap out.
      awakeSeconds += gap <= tailSeconds ? gap : tailSeconds;
    });
  }
  return { awakeHours: awakeSeconds / 3600, wakes, cpuHours: cpuSeconds / 3600 };
}

export function replay(
  turns: ReadonlyArray<ReplayTurn>,
  prices: ReadonlyArray<MachinePrice>,
  idleTailsSeconds: ReadonlyArray<number>,
): Replay {
  const kept = turns.filter(
    (turn) => turn.durationSeconds >= 0 && turn.durationSeconds < MAX_TURN_SECONDS,
  );
  const byThread = new Map<string, Array<TimedTurn>>();
  const userDays = new Set<string>();
  for (const turn of kept) {
    const end = turn.endedAtMs / 1000;
    const start = end - turn.durationSeconds;
    const key = `${turn.userId}\u0000${turn.threadId}`;
    const thread = byThread.get(key) ?? [];
    thread.push({ turn, start, end });
    byThread.set(key, thread);
    userDays.add(
      `${turn.userId}\u0000${DateTime.formatIsoDateUtc(DateTime.makeUnsafe(start * 1000))}`,
    );
  }
  const threads = [...byThread.values()].map((thread) =>
    thread.toSorted((a, b) => a.start - b.start),
  );

  const rows = idleTailsSeconds.map((idleTailSeconds): ReplayRow => {
    const { awakeHours, wakes, cpuHours } = simulate(threads, idleTailSeconds);
    const costPerUserDay = new Map(
      prices.map((price) => [
        price.id,
        (cpuHours * price.activeCpuPerVcpuHour + awakeHours * price.awakePerHour) /
          Math.max(1, userDays.size),
      ]),
    );
    return { idleTailSeconds, awakeHours, wakes, cpuHours, costPerUserDay };
  });

  return {
    turns: kept.length,
    userDays: userDays.size,
    measuredCpuTurns: kept.filter((turn) => turn.cpuSeconds !== undefined).length,
    rows,
  };
}

const formatTail = (seconds: number) =>
  seconds < 60 ? `${seconds} s` : `${Math.round((seconds / 60) * 10) / 10} min`;

/** The replay as #116's Markdown table. */
export function formatReplayTable(result: Replay, prices: ReadonlyArray<MachinePrice>): string {
  const header = [
    "Idle tail before stop",
    "VM awake h",
    "Wakes",
    ...prices.map((price) => price.label),
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...result.rows.map((row) => {
      const cells = [
        formatTail(row.idleTailSeconds),
        Math.round(row.awakeHours).toLocaleString("en-US"),
        row.wakes.toLocaleString("en-US"),
        ...prices.map((price) => `$${(row.costPerUserDay.get(price.id) ?? 0).toFixed(3)}/day`),
      ];
      return `| ${cells.join(" | ")} |`;
    }),
  ];
  return lines.join("\n");
}
