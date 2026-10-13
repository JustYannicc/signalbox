/**
 * Which client devices a notification lands on. Devices sit at Home levels
 * like everything else: a thing at level L goes to the devices at L or above
 * it on L's chain, so the Personal phone gets Personal things, the Work laptop
 * Work's (Northwind's too), and a top-level device everything. Top-level
 * things are yours and Appa's, so they go to every device in sight.
 *
 * Focus is view-only, but out of sight is out of mind: nothing about a hidden
 * thing lands anywhere. Escalation rules (`escalation.ts`) add their devices
 * on top, whatever Focus hides. Each device's own setting (badge, urgent
 * only, off) still decides how it shows; this only picks which ones.
 */
import { isLevelInFocus } from "../sidebar/focus/focusLevels";
import { matchingRules, type EscalationRule, type EscalationSubject } from "./escalation";
import { levelChain, TOP_LEVEL, type LevelKey } from "./levels";

/** Anything placed like a client device. */
export interface PlacedDevice {
  readonly id: string;
  readonly level: LevelKey;
}

type Placement = Parameters<typeof isLevelInFocus>[2];

/** Devices that get pings about a thing at `thingLevel`, with `focus` in sight. */
export function devicesFor<D extends PlacedDevice>(
  thingLevel: LevelKey,
  devices: readonly D[],
  focus: LevelKey,
  placement?: Placement,
): readonly D[] {
  if (!isLevelInFocus(thingLevel, focus, placement)) return [];
  if (thingLevel === TOP_LEVEL) {
    return devices.filter((device) => isLevelInFocus(device.level, focus, placement));
  }
  const chain = levelChain(thingLevel, placement);
  return devices.filter((device) => chain.includes(device.level));
}

export interface Delivery<D> {
  readonly devices: readonly D[];
  /** The rules that added devices, or broke through Focus. */
  readonly escalatedBy: readonly EscalationRule[];
}

/**
 * Where a notification about `subject` lands: the devices its levels route
 * to (empty levels = the top level), plus every device a matching escalation
 * rule names. Device order follows `devices`.
 */
export function deliveryFor<D extends PlacedDevice>(
  subject: EscalationSubject,
  devices: readonly D[],
  focus: LevelKey,
  rules: readonly EscalationRule[],
  placement?: Placement,
): Delivery<D> {
  const levels = subject.levels.length > 0 ? subject.levels : [TOP_LEVEL];
  const ids = new Set(
    levels.flatMap((level) => devicesFor(level, devices, focus, placement)).map((d) => d.id),
  );
  const escalatedBy = matchingRules(subject, rules, placement);
  for (const rule of escalatedBy) for (const id of rule.deviceIds) ids.add(id);
  return { devices: devices.filter((device) => ids.has(device.id)), escalatedBy };
}

/** What a device at `level` gets pings about, for "Pings about …" copy. */
export function deliveryScopeLabel(level: LevelKey, label: string): string {
  return level === TOP_LEVEL ? "everything" : `${label} and everything inside, plus the top level`;
}
