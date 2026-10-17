import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { createContext } from "react";

/**
 * signalbox: a turn whose run hasn't started working yet is still setting up
 * its machine (provisioning, checkout, dependencies). The thread says so with
 * the same states the sidebar's "Setting up" pill uses (resolveThreadStatusPill).
 */
export function runtimeIsSettingUp(status: ThreadRuntimeSummary["status"] | undefined): boolean {
  return status === "preparing" || status === "starting" || status === "queued";
}

/** Whether the open thread's turn is setting up; MessagesTimeline provides it from its `settingUpMachine` prop. */
export const SettingUpMachineContext = createContext(false);
