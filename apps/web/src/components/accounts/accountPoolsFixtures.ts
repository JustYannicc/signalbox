/**
 * PLACEHOLDER DATA. Accounts and their server pins live in the shared fleet
 * fixture (devices/fleet.ts) so Devices and Plugins groups agree with this
 * page; this file groups them into pools and adds pools others share with
 * you. Delete with the fleet once accounts are real.
 */
import { CURRENT_PERSON_ID } from "../multiplayer/multiplayerFixtures";
import { FLEET_ACCOUNTS, FLEET_UPDATED_AT } from "../devices/fleet";
import type { AccountPool, PoolAccount, PoolHarness } from "./accountPoolsModel";

export const QUOTAS_UPDATED_AT = FLEET_UPDATED_AT;

const byIds = (...ids: readonly string[]): readonly PoolAccount[] =>
  FLEET_ACCOUNTS.filter((account) => ids.includes(account.id));

/** A friend's account: it exits through their server, not yours. */
const SAMIR_CLAUDE: PoolAccount = {
  id: "claude-samir",
  harness: "claude",
  name: "samir@home.example",
  plan: "Max 20×",
  groupIds: ["personal"],
  state: "active",
  windows: [
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 35,
      windowDurationMins: 7 * 24 * 60,
    },
  ],
  resetCredits: { availableCount: 0 },
  pin: { serverId: "samir-home" },
};

export const ACCOUNT_POOLS: readonly AccountPool[] = [
  {
    id: "personal-codex",
    name: "Codex",
    harness: "codex",
    ownerId: CURRENT_PERSON_ID,
    accounts: byIds("codex-personal", "codex-side"),
    grants: [{ kind: "person", personId: "sam", role: "use" }],
  },
  {
    id: "personal-claude",
    name: "Claude Max",
    harness: "claude",
    ownerId: CURRENT_PERSON_ID,
    accounts: byIds("claude-personal"),
    grants: [],
  },
  {
    id: "personal-grok",
    name: "Grok",
    harness: "grok",
    ownerId: CURRENT_PERSON_ID,
    accounts: byIds("grok-personal"),
    grants: [{ kind: "group", groupId: "northwind", role: "use" }],
  },
  {
    id: "northwind-codex",
    name: "Northwind Codex pool",
    harness: "codex",
    ownerId: "flo",
    orgName: "Northwind",
    accounts: byIds("codex-northwind", "codex-northwind-2"),
    grants: [{ kind: "group", groupId: "northwind", role: "use" }],
  },
  {
    id: "northwind-claude",
    name: "Northwind Claude pool",
    harness: "claude",
    ownerId: "flo",
    orgName: "Northwind",
    accounts: byIds("claude-northwind"),
    grants: [{ kind: "group", groupId: "northwind", role: "use" }],
  },
  {
    id: "samir-claude",
    name: "Samir's Claude",
    harness: "claude",
    ownerId: "sam",
    accounts: [SAMIR_CLAUDE],
    grants: [{ kind: "person", personId: CURRENT_PERSON_ID, role: "use" }],
  },
];

/** Shared pools you've connected to; the rest wait for "Connect". */
export const INITIALLY_CONNECTED: ReadonlySet<string> = new Set([
  "northwind-codex",
  "northwind-claude",
]);

export function isUsable(pool: AccountPool, connected: ReadonlySet<string>): boolean {
  return pool.ownerId === CURRENT_PERSON_ID || connected.has(pool.id);
}

/** Every account you can route to today: your pools plus connected shared ones. */
export const POOL_ACCOUNTS: readonly PoolAccount[] = ACCOUNT_POOLS.filter((pool) =>
  isUsable(pool, INITIALLY_CONNECTED),
).flatMap((pool) => pool.accounts);

/** Weekly allowance burned per day at your recent pace, in account-weeks. */
export const USAGE_PACE: Record<PoolHarness, number> = {
  codex: 0.3,
  claude: 0.05,
  grok: 0.02,
};
