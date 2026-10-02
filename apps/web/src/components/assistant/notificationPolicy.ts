/**
 * When supervisors (the assistant, section, project and workflow agents) may
 * notify the user, and where it lands. PLACEHOLDER persistence: localStorage
 * only. Each agent's bell can override the default policy ("important": the
 * agent decides what is worth a ping). The computer is always quiet (badge and
 * sidebar marker, no sound); the phone only gets urgent things while you're
 * away, and can be switched off. Presence is detected, not configured.
 */
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { CLIENT_DEVICES } from "../devices/devicesFixtures";

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

/** Where pings land, given the phone switch. Empty when nothing pings. */
export function notifyDeliveryHint(policy: NotifyPolicy, phone: boolean): string {
  if (policy === "none") return "";
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
const NO_OVERRIDES: typeof OverridesSchema.Type = {};

const DEFAULTS_KEY = "t3code:assistant-notify-defaults:v3";
const OVERRIDES_KEY = "t3code:assistant-notify-overrides:v1";

export function useNotifyDefaults() {
  return useLocalStorage(DEFAULTS_KEY, DEFAULT_NOTIFY_DEFAULTS, NotifyDefaultsSchema);
}

/**
 * One agent's effective policy (`agentKey` is "assistant" or an `/agent` id),
 * its setter, and whether it overrides the default. `setPolicy(null)` clears
 * the override so the agent follows the default again.
 */
export function useNotifyPolicy(agentKey: string) {
  const [defaults] = useNotifyDefaults();
  const [overrides, setOverrides] = useLocalStorage(OVERRIDES_KEY, NO_OVERRIDES, OverridesSchema);
  const override = overrides[agentKey];
  const policy = override ?? defaults.policy;
  const setPolicy = (next: NotifyPolicy | null) =>
    setOverrides((prev) => {
      if (next !== null) return { ...prev, [agentKey]: next };
      const { [agentKey]: _cleared, ...rest } = prev;
      return rest;
    });
  return [policy, setPolicy, override !== undefined] as const;
}
