/**
 * Where a ping lands, end to end: Focus (out of sight, out of mind), the
 * nearest notification rule on its level's chain (a mute), the devices its
 * level routes to by their own settings, and escalation rules on top.
 * `routePing` is the one place that combines them; Settings › Notifications
 * shows the recent pings below through it. PLACEHOLDER: the pings are
 * fixtures, nothing is sent.
 */
import { resolveNotifyPolicy, type NotifyPolicy } from "../assistant/notificationPolicy";
import { isLevelInFocus } from "../sidebar/focus/focusLevels";
import { deliveryFor, type PlacedDevice } from "./delivery";
import type { EscalationRule, EscalationStatus } from "./escalation";
import { TOP_LEVEL, type LevelKey } from "./levels";

export interface Ping {
  readonly id: string;
  readonly title: string;
  /** Where the ping is about; the top level for Appa's own. */
  readonly level: LevelKey;
  /** Null for a plain update. */
  readonly status: EscalationStatus | null;
  readonly ago: string;
}

export type PingRoute<D> =
  /** Focus hides its level and no rule breaks through: show nothing about it. */
  | { readonly kind: "hidden" }
  /** The nearest rule on its chain says Nothing (set at `from`). */
  | { readonly kind: "muted"; readonly from: LevelKey }
  | {
      readonly kind: "landed";
      readonly devices: readonly D[];
      readonly escalatedBy: readonly EscalationRule[];
      /** Its own level is out of sight; only an escalation rule let it through. */
      readonly brokeThrough: boolean;
    };

/**
 * Escalation outranks a mute and Focus: a rule names its devices on purpose.
 * Muted with a rule holding, only the rule's devices get it.
 */
export function routePing<D extends PlacedDevice>(
  ping: Ping,
  context: {
    readonly devices: readonly D[];
    readonly focus: LevelKey;
    readonly rules: readonly EscalationRule[];
    readonly overrides: Readonly<Record<string, NotifyPolicy>>;
    readonly fallback: NotifyPolicy;
    readonly placement?: Parameters<typeof isLevelInFocus>[2];
  },
): PingRoute<D> {
  const { devices, focus, rules, placement } = context;
  const subject = { levels: [ping.level], status: ping.status };
  const delivery = deliveryFor(subject, devices, focus, rules, placement);
  const escalated = delivery.escalatedBy.length > 0;
  const inSight = isLevelInFocus(ping.level, focus, placement);
  if (!inSight && !escalated) return { kind: "hidden" };
  const policy = resolveNotifyPolicy(ping.level, context.overrides, context.fallback, placement);
  if (policy.policy === "none") {
    if (!escalated) return { kind: "muted", from: policy.from ?? ping.level };
    const named = new Set(delivery.escalatedBy.flatMap((rule) => rule.deviceIds));
    return {
      kind: "landed",
      devices: devices.filter((device) => named.has(device.id)),
      escalatedBy: delivery.escalatedBy,
      brokeThrough: !inSight,
    };
  }
  return { kind: "landed", ...delivery, brokeThrough: !inSight };
}

/**
 * PLACEHOLDER: the last few pings, one per rule worth seeing. With Focus on
 * Personal: the terminal-app approval breaks through to the Pixel only,
 * merchant-portal's failure stays out of sight, Personal's own question is
 * muted, its project's CI failure still lands (nearest rule wins), and
 * Appa's question goes to every device in sight.
 */
export function recentPings(personalProject: LevelKey | null, projectName = "signalbox"): Ping[] {
  return [
    {
      id: "terminal-app-pilot",
      title: "Roll the A920 printer fix out to the pilot terminals?",
      level: "team-project:terminal-app",
      status: "approval",
      ago: "6m ago",
    },
    {
      id: "appa-lisbon-seat",
      title: "Window or aisle for the Lisbon flight? Check-in opens tonight.",
      level: TOP_LEVEL,
      status: "input",
      ago: "18m ago",
    },
    {
      id: "merchant-portal-webhooks",
      title: "Refund webhook retries failed again",
      level: "team-project:merchant-portal",
      status: "failed",
      ago: "25m ago",
    },
    ...(personalProject
      ? [
          {
            id: "personal-project-ci",
            title: `CI failed on ${projectName} main`,
            level: personalProject,
            status: "failed" as const,
            ago: "40m ago",
          },
        ]
      : []),
    {
      id: "personal-tax-receipts",
      title: "Tax return: three receipts are missing",
      level: "section:personal",
      status: "input",
      ago: "1h ago",
    },
  ];
}
