/**
 * Shape of a visible computer session: a real OS an agent acquired for work
 * that just-bash can't do. Compute and retained disk are billed separately.
 */

export type ComputerOs = "linux" | "windows" | "macos";

/** live = billing compute, paused = disk kept and compute stopped, released = files retained only. */
export type ComputerState = "live" | "paused" | "released";

export type ComputerStepStatus = "done" | "running" | "pending" | "failed";

export interface ComputerStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: ComputerStepStatus;
  /** Minutes since acquire when the step started, for the timeline stamp. */
  readonly atMinute: number | null;
}

export interface ComputerArtifact {
  readonly name: string;
  readonly kind: "screenshot" | "log" | "report" | "archive";
  readonly bytes: number;
}

/** The task or chat that acquired the computer. */
export interface ComputerOwner {
  readonly kind: "task" | "chat";
  readonly title: string;
  /** Item id under `/shared/$threadId`; null opens the assistant's trace instead. */
  readonly sharedThreadId: string | null;
}

export interface Computer {
  readonly id: string;
  readonly name: string;
  readonly os: ComputerOs;
  readonly osVersion: string;
  readonly provider: string;
  readonly region: string;
  readonly size: string;
  readonly acquiredBy: ComputerOwner;
  readonly state: ComputerState;
  /** Minutes since the computer was acquired (live) or since it stopped (paused/released). */
  readonly minutes: number;
  readonly computeUsd: number;
  readonly storageUsd: number;
  readonly computeRateUsdPerHour: number;
  readonly retainedGb: number;
  /** What the placeholder live view shows in its browser tab. */
  readonly browserUrl: string;
  readonly steps: ReadonlyArray<ComputerStep>;
  readonly artifacts: ReadonlyArray<ComputerArtifact>;
  readonly lastSyncMinutesAgo: number;
}

export const OS_LABEL: Record<ComputerOs, string> = {
  linux: "Linux",
  windows: "Windows",
  macos: "macOS",
};

export const STATE_LABEL: Record<ComputerState, string> = {
  live: "Live",
  paused: "Paused",
  released: "Released",
};

export function formatUsd(value: number): string {
  return value < 1 ? `$${value.toFixed(3).replace(/0$/, "")}` : `$${value.toFixed(2)}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function totalCost(computer: Computer): number {
  return computer.computeUsd + computer.storageUsd;
}

const PROVENANCE_VERB: Record<ComputerState, string> = {
  live: "Acquired by",
  paused: "Paused from",
  released: "Released from",
};

/** Provenance pieces, e.g. `Acquired by` + `task` + `12m`; callers render the title. */
export function provenanceParts(computer: Computer): { verb: string; kind: string; age: string } {
  const age = formatMinutes(computer.minutes);
  return {
    verb: PROVENANCE_VERB[computer.state],
    kind: computer.acquiredBy.kind,
    age: computer.state === "live" ? age : `${age} ago`,
  };
}

/** Plain-text provenance for places that are already a link, e.g. `Acquired by task 'Build landing page' · 12m`. */
export function provenanceText(computer: Computer): string {
  const { verb, kind, age } = provenanceParts(computer);
  return `${verb} ${kind} '${computer.acquiredBy.title}' · ${age}`;
}
