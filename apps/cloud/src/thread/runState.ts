import type { OrchestrationV2Run } from "@t3tools/contracts";

type Run = OrchestrationV2Run;

type LiveRun = Run & { readonly status: "preparing" | "starting" | "running" | "waiting" };

/** A run the provider is (or is about to be) working on. */
export const isLiveRun = (run: Run): run is LiveRun =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";
