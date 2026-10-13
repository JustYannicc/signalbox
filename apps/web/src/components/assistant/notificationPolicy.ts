/**
 * When supervisors (the assistant, section, project and workflow agents) may
 * notify the user, and where it lands. PLACEHOLDER: prototype state
 * (`usePrototypeState`). Each agent's bell can override the default policy ("important":
 * the agent decides what is worth a ping). The computer is always quiet (badge and
 * sidebar marker, no sound); the phone only gets urgent things while you're
 * away, and can be switched off. Presence is detected, not configured.
 *
 * An override is a rule at a level (the bell of the level's agent sets it) and
 * holds for everything below: the nearest override up the chain wins, so
 * "mute Personal" mutes its projects unless a project sets its own. Which
 * devices a ping lands on follows levels too (`levels/delivery.ts`): each
 * device sits at a level and gets that level's pings. Escalation rules
 * (`levels/escalation.ts`) say what breaks through Focus.
 */
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { usePrototypeState } from "../../lib/prototypeStorage";
import { CLIENT_DEVICES } from "../devices/devicesFixtures";
import type { ClientDevice } from "../devices/devicesModel";
import { joinWords } from "../levels/escalation";
import type { LevelOption } from "../levels/levelOptions";
import { levelChain, nearestOnChain, TOP_LEVEL, type LevelKey } from "../levels/levels";

export const NOTIFY_POLICIES = ["all", "important", "none"] as const;
const NotifyPolicySchema = Schema.Literals(NOTIFY_POLICIES);
export type NotifyPolicy = typeof NotifyPolicySchema.Type;

export const NOTIFY_POLICY_LABEL: Record<NotifyPolicy, string> = {
  all: "Everything",
  important: "Only important",
  none: "Nothing",
};

export const NOTIFY_POLICY_DETAIL: Record<NotifyPolicy, string> = {
  all: "Every update",
  important: "The agent decides",
  none: "Stays in the chat",
};

/** Names of the user's computer and phone, for copy. */
export const NOTIFY_DEVICE_NAMES = {
  computer: CLIENT_DEVICES.find((device) => device.kind === "laptop")?.name ?? "computer",
  phone: CLIENT_DEVICES.find((device) => device.kind === "phone")?.name ?? "phone",
};

export function notifyPolicyHint(policy: NotifyPolicy, agentName: string): string {
  if (policy === "all") return `Every update from ${agentName} pings you.`;
  if (policy === "none") return `${agentName} never pings you. Everything stays in the chat.`;
  return `${agentName} decides what's worth a ping. The rest stays in the chat.`;
}

/**
 * Where pings land, given the phone switch. Empty when nothing pings. Pass
 * `devices` (the ones a level routes to, see `levels/delivery.ts`) to name
 * them; without it the copy speaks of your computer and phone.
 */
export function notifyDeliveryHint(
  policy: NotifyPolicy,
  phone: boolean,
  devices?: readonly Pick<ClientDevice, "kind" | "name">[],
): string {
  if (policy === "none") return "";
  if (devices) {
    if (devices.length === 0)
      return "No device sits on this folder's chain, so pings stay in the app.";
    const computers = joinWords(devices.filter((d) => d.kind === "laptop").map((d) => d.name));
    const phones = joinWords(devices.filter((d) => d.kind === "phone").map((d) => d.name));
    const badge = computers ? `A quiet badge on ${computers}.` : "";
    const away = !phones
      ? ""
      : phone
        ? `Away: urgent things go to ${phones}.`
        : `Nothing goes to ${phones}.`;
    return [badge, away].filter(Boolean).join(" ");
  }
  const { phone: phoneName } = NOTIFY_DEVICE_NAMES;
  return phone
    ? `At your computer: a quiet badge. Away: urgent things go to your ${phoneName}.`
    : `A quiet badge on your computer. Nothing goes to your ${phoneName}.`;
}

const NotifyDefaultsSchema = Schema.Struct({
  policy: NotifyPolicySchema,
  /** Plain-words rule the agents apply under "important". */
  rule: Schema.String,
  /** Phone push for urgent things while you're away. */
  phone: Schema.Boolean,
});
export type NotifyDefaults = typeof NotifyDefaultsSchema.Type;

export const DEFAULT_NOTIFY_DEFAULTS: NotifyDefaults = {
  policy: "important",
  rule: "Only ping me if something breaks or needs my approval.",
  phone: true,
};

const OverridesSchema = Schema.Record(Schema.String, NotifyPolicySchema);
/** Policy per level key (older saves: per agent id, see `migrateNotifyOverrides`). */
type NotifyOverrides = typeof OverridesSchema.Type;
const NO_OVERRIDES: NotifyOverrides = {};

const DEFAULTS_KEY = "t3code:assistant-notify-defaults:v3";
const OVERRIDES_KEY = "t3code:assistant-notify-overrides:v1";

export function useNotifyDefaults() {
  return usePrototypeState(DEFAULTS_KEY, DEFAULT_NOTIFY_DEFAULTS);
}

/** Level keys are `root` or `kind:id`; anything else is an agent id from before levels. */
const isLevelKey = (key: string) => key === TOP_LEVEL || key.includes(":");

/** Which level an agent represents: the assistant is the top level's. */
export function agentLevel(agentKey: string, options: readonly LevelOption[]): LevelKey | null {
  if (agentKey === "assistant") return TOP_LEVEL;
  return options.find((option) => option.agentId === agentKey)?.key ?? null;
}

/**
 * Re-keys overrides saved per agent id to their level. A level key already
 * set wins; agents with no known level (yet) keep their entry untouched.
 */
export function migrateNotifyOverrides(
  overrides: NotifyOverrides,
  levelOf: (agentKey: string) => LevelKey | null,
): NotifyOverrides {
  const legacy = Object.keys(overrides).filter((key) => !isLevelKey(key));
  if (legacy.length === 0) return overrides;
  const next: Record<string, NotifyPolicy> = { ...overrides };
  for (const agentKey of legacy) {
    const level = levelOf(agentKey);
    if (level === null) continue;
    const policy = next[agentKey];
    delete next[agentKey];
    if (policy !== undefined && next[level] === undefined) next[level] = policy;
  }
  return next;
}

/** The nearest override on `level`'s chain, else the default. `from` is the overriding level. */
export function resolveNotifyPolicy(
  level: LevelKey,
  overrides: NotifyOverrides,
  fallback: NotifyPolicy,
  placement?: Parameters<typeof levelChain>[1],
): { readonly policy: NotifyPolicy; readonly from: LevelKey | null } {
  const from = nearestOnChain(level, Object.keys(overrides).filter(isLevelKey), placement);
  return { policy: (from === null ? undefined : overrides[from]) ?? fallback, from };
}

/**
 * Every override by level (legacy agent-keyed entries re-keyed via `options`)
 * and a setter; `setOverride(level, null)` clears it so the level inherits.
 */
export function useNotifyOverrides(options: readonly LevelOption[]) {
  const [stored, setStored] = usePrototypeState(OVERRIDES_KEY, NO_OVERRIDES);
  const levelOf = useCallback((agentKey: string) => agentLevel(agentKey, options), [options]);
  const overrides = useMemo(() => migrateNotifyOverrides(stored, levelOf), [levelOf, stored]);
  const setOverride = useCallback(
    (level: LevelKey, next: NotifyPolicy | null) =>
      setStored((prev) => {
        const { [level]: _cleared, ...rest } = migrateNotifyOverrides(prev, levelOf);
        return next === null ? rest : { ...rest, [level]: next };
      }),
    [levelOf, setStored],
  );
  return [overrides, setOverride] as const;
}

/**
 * One level's effective policy, its setter, whether the level overrides it,
 * and what it would inherit without its own override (`from`: the level that
 * sets it, or null for the default). `setPolicy(null)` goes back to inheriting.
 */
export function useNotifyPolicy(level: LevelKey, options: readonly LevelOption[]) {
  const [defaults] = useNotifyDefaults();
  const [overrides, setOverride] = useNotifyOverrides(options);
  const { [level]: own, ...above } = overrides;
  const inherited = resolveNotifyPolicy(level, above, defaults.policy);
  const setPolicy = (next: NotifyPolicy | null) => setOverride(level, next);
  return [own ?? inherited.policy, setPolicy, own !== undefined, inherited] as const;
}
