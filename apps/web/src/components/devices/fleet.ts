/**
 * PLACEHOLDER DATA. One fleet for every surface: the servers chats run on, the
 * pooled model accounts, and which server each account exits through. Devices,
 * Usage › Accounts, and Plugins groups all read this, so they can't disagree.
 * Nothing comes from a server; delete once servers and accounts are real.
 * Times are relative to page load so countdowns stay plausible.
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import type { PoolAccount } from "../accounts/accountPoolsModel";
import type { ExecutionServer, RolloutStep } from "./devicesModel";

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK_MINS = 7 * 24 * 60;
const inTime = (days: number, hours = 0) => new Date(NOW + days * DAY + hours * HOUR).toISOString();

function weekly(usedPercent: number, resetsInDays: number, hours = 0): ServerProviderUsageWindow {
  return {
    id: "weekly",
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    resetsAt: inTime(resetsInDays, hours),
    windowDurationMins: WEEK_MINS,
  };
}

export const FLEET_UPDATED_AT = NOW - 3 * 60_000;

export const FLEET_SERVERS: readonly ExecutionServer[] = [
  {
    id: "zrh-1",
    name: "zrh-1",
    runtime: "hetzner",
    where: "Hetzner · Zürich",
    state: "online",
    chats: 7,
    movedInChats: 3,
    load: 64,
    version: "0.42.1",
    canPinAccounts: true,
  },
  {
    id: "home-mini",
    name: "home-mini",
    runtime: "home",
    where: "Mac mini · Home",
    state: "draining",
    chats: 3,
    load: 21,
    version: "0.42.0",
    canPinAccounts: true,
    drain: { movingChats: 3, toServerId: "zrh-1" },
  },
  {
    id: "celld-fra",
    name: "celld-fra",
    runtime: "celld",
    where: "celld · Hetzner Frankfurt",
    state: "queued",
    chats: 4,
    load: 38,
    version: "0.42.0",
    canPinAccounts: true,
  },
  {
    id: "cf-do",
    name: "Hosted",
    runtime: "cloudflare-do",
    where: "Cloudflare · one object per chat",
    state: "online",
    chats: 12,
    version: "0.42.1",
    canPinAccounts: false,
  },
];

export const ROLLOUT_VERSION = "0.42.1";

export const ROLLOUT_STEPS: readonly RolloutStep[] = [
  { serverId: "zrh-1", status: "done", note: "Updated 14:02" },
  { serverId: "home-mini", status: "current", phase: "drain", note: "3 chats moving to zrh-1" },
  { serverId: "celld-fra", status: "next", note: "Starts when home-mini is back" },
];

export const FLEET_ACCOUNTS: readonly PoolAccount[] = [
  {
    id: "codex-personal",
    harness: "codex",
    name: "yannic@personal.example",
    plan: "Pro",
    groupIds: ["personal"],
    state: "active",
    windows: [weekly(100, 2, 21)],
    resetCredits: { availableCount: 3, nextExpiresAt: inTime(4, 2) },
    pin: { serverId: "home-mini", reroutedViaServerId: "zrh-1" },
  },
  {
    id: "codex-northwind",
    harness: "codex",
    name: "yannic@northwind.example",
    plan: "Business",
    groupIds: ["northwind"],
    state: "active",
    windows: [weekly(88, 2, 21)],
    resetCredits: { availableCount: 3, nextExpiresAt: inTime(1, 6) },
    pin: { serverId: "zrh-1" },
  },
  {
    id: "codex-northwind-2",
    harness: "codex",
    name: "codex-2@northwind.example",
    plan: "Business",
    groupIds: ["northwind"],
    state: "active",
    windows: [weekly(45, 4, 3)],
    resetCredits: { availableCount: 1, nextExpiresAt: inTime(6, 0) },
    pin: { serverId: "zrh-1" },
  },
  {
    id: "codex-side",
    harness: "codex",
    name: "builds@personal.example",
    plan: "Plus",
    groupIds: ["personal"],
    state: "paused",
    windows: [weekly(33, 6, 4)],
    resetCredits: { availableCount: 0 },
    pin: { serverId: "celld-fra" },
  },
  {
    id: "claude-personal",
    harness: "claude",
    name: "yannic@personal.example",
    plan: "Max 20×",
    groupIds: ["personal"],
    state: "active",
    windows: [weekly(20, 5, 11)],
    resetCredits: { availableCount: 0 },
    pin: { serverId: "celld-fra" },
  },
  {
    id: "claude-northwind",
    harness: "claude",
    name: "yannic@northwind.example",
    plan: "Team",
    groupIds: ["northwind"],
    state: "needsLogin",
    windows: [weekly(59, 3, 8)],
    resetCredits: { availableCount: 0 },
    pin: { serverId: "zrh-1" },
  },
  {
    id: "grok-personal",
    harness: "grok",
    name: "@justyannicc",
    plan: "SuperGrok Heavy",
    groupIds: ["personal", "northwind"],
    state: "active",
    windows: [weekly(4, 4, 15)],
    resetCredits: { availableCount: 0 },
    pin: { serverId: "celld-fra" },
  },
];

/** Accounts exiting through a server right now, including ones rerouted onto it. */
export function accountsExitingVia(serverId: string): readonly PoolAccount[] {
  return FLEET_ACCOUNTS.filter(
    (account) => (account.pin.reroutedViaServerId ?? account.pin.serverId) === serverId,
  );
}

export function fleetServer(serverId: string): ExecutionServer | undefined {
  return FLEET_SERVERS.find((server) => server.id === serverId);
}
