/**
 * When supervisors (the assistant, section, project and workflow agents) may
 * notify the user, and where it lands. PLACEHOLDER: prototype state
 * (`usePrototypeState`). Each agent's bell can override the default policy
 * ("important": the agent decides what is worth a ping). Each device has its
 * own setting (quiet badge, urgent only, off) on the Devices page.
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

export function notifyPolicyHint(policy: NotifyPolicy, agentName: string): string {
  if (policy === "all") return `Every update from ${agentName} pings you.`;
  if (policy === "none") return `${agentName} never pings you. Everything stays in the chat.`;
  return `${agentName} decides what's worth a ping. The rest stays in the chat.`;
}

/**
 * Where pings land: the devices a level routes to (see `levels/delivery.ts`),
 * by each device's own setting. Empty when nothing pings.
 */
export function notifyDeliveryHint(
  policy: NotifyPolicy,
  devices: readonly Pick<ClientDevice, "name" | "notify">[],
): string {
  if (policy === "none") return "";
  const named = (notify: ClientDevice["notify"]) =>
    joinWords(devices.filter((device) => device.notify === notify).map((device) => device.name));
  const lines = [
    named("all") && `Everything shows on ${named("all")}.`,
    named("badge") && `A quiet badge on ${named("badge")}.`,
    named("urgent") && `Only urgent things reach ${named("urgent")}.`,
  ].filter(Boolean);
  return lines.length > 0
    ? lines.join(" ")
    : "No device on this folder's chain takes pings, so they stay in the app.";
}

const NotifyDefaultsSchema = Schema.Struct({
  policy: NotifyPolicySchema,
  /** Plain-words rule the agents apply under "important". */
  rule: Schema.String,
});
export type NotifyDefaults = typeof NotifyDefaultsSchema.Type;

export const DEFAULT_NOTIFY_DEFAULTS: NotifyDefaults = {
  policy: "important",
  rule: "Only ping me if something breaks or needs my approval.",
};

const OverridesSchema = Schema.Record(Schema.String, NotifyPolicySchema);
/** Policy per level key (older saves: per agent id, see `migrateNotifyOverrides`). */
type NotifyOverrides = typeof OverridesSchema.Type;

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
 * PLACEHOLDER demo: a project in Personal (signalbox or t3code when you have
 * one, else the first), the one that keeps pinging while Personal is muted.
 */
export function demoPersonalProject(options: readonly LevelOption[]): LevelOption | null {
  const section = options.findIndex((option) => option.key === "section:personal");
  if (section < 0) return null;
  const depth = options[section]?.depth ?? 0;
  const inside: LevelOption[] = [];
  for (const option of options.slice(section + 1)) {
    if (option.depth <= depth) break;
    if (option.kind === "project" && option.depth === depth + 1) inside.push(option);
  }
  return inside.find((option) => /signalbox|t3code/i.test(option.name)) ?? inside[0] ?? null;
}

/**
 * PLACEHOLDER demo overrides until you set your own: Personal muted, with one
 * of its projects still pinging what's important (the nearest rule wins).
 */
export function demoNotifyOverrides(options: readonly LevelOption[]): NotifyOverrides {
  const project = demoPersonalProject(options);
  return {
    "section:personal": "none",
    ...(project ? { [project.key]: "important" as const } : {}),
  };
}

/**
 * Every override by level (legacy agent-keyed entries re-keyed via `options`)
 * and a setter; `setOverride(level, null)` clears it so the level inherits.
 */
export function useNotifyOverrides(options: readonly LevelOption[]) {
  const demo = useMemo(() => demoNotifyOverrides(options), [options]);
  const [stored, setStored] = usePrototypeState(OVERRIDES_KEY, demo);
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
