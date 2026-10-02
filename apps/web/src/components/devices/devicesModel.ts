/**
 * Shapes for the Devices prototype. Two device types: servers run chats,
 * clients are gateways a server can reach into. Nothing is wired yet.
 */
import { toastManager } from "../ui/toast";

export type ServerRuntime = "hetzner" | "cloudflare-do" | "home" | "celld";

export type ServerState = "online" | "draining" | "updating" | "queued";

export interface ExecutionServer {
  readonly id: string;
  readonly name: string;
  readonly runtime: ServerRuntime;
  readonly where: string;
  readonly state: ServerState;
  readonly chats: number;
  /** Chats parked here while another server drains; they move back after. */
  readonly movedInChats?: number;
  /** Percent. Absent for runtimes that scale per chat. */
  readonly load?: number;
  readonly version: string;
  /** Per-chat runtimes have no fixed IP, so no account can exit through them. */
  readonly canPinAccounts: boolean;
  readonly drain?: { readonly movingChats: number; readonly toServerId: string };
}

export type RolloutPhase = "drain" | "update" | "return";

export interface RolloutStep {
  readonly serverId: string;
  readonly status: "done" | "current" | "next";
  readonly phase?: RolloutPhase;
  readonly note: string;
}

export type CapabilityGroup = "files" | "device" | "signals";

export interface GatewayCapability {
  readonly id: string;
  readonly group: CapabilityGroup;
  readonly label: string;
  readonly detail: string;
  readonly enabled: boolean;
  /** Set when the hardware or OS can't provide it. */
  readonly unavailable?: string;
}

/**
 * Per-device delivery, matching the assistant's notification policy: the
 * computer you're at gets a quiet badge, the phone only urgent pushes.
 */
export const DEVICE_NOTIFY_LEVELS = ["all", "badge", "urgent", "none"] as const;
export type DeviceNotifyLevel = (typeof DEVICE_NOTIFY_LEVELS)[number];

export const DEVICE_NOTIFY_LABEL: Record<DeviceNotifyLevel, string> = {
  all: "All",
  badge: "Quiet badge",
  urgent: "Urgent only",
  none: "Off",
};

export function isDeviceNotifyLevel(value: unknown): value is DeviceNotifyLevel {
  return DEVICE_NOTIFY_LEVELS.some((level) => level === value);
}

/** A client app. Clients never execute work; a machine that should gets added as a server. */
export interface ClientDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: "laptop" | "phone";
  readonly os: string;
  readonly thisDevice: boolean;
  readonly activeNow: boolean;
  readonly lastSeen: string;
  readonly notify: DeviceNotifyLevel;
  readonly capabilities: readonly GatewayCapability[];
}

export const CAPABILITY_GROUP_LABEL: Record<CapabilityGroup, string> = {
  files: "Files",
  device: "Device",
  signals: "Signals for automations",
};

export const PHASES: readonly RolloutPhase[] = ["drain", "update", "return"];

export const PHASE_LABEL: Record<RolloutPhase, string> = {
  drain: "Drain",
  update: "Update",
  return: "Return",
};

/** Anchor id for a server row, so account pins can link straight to it. */
export function serverAnchor(serverId: string): string {
  return `server-${serverId}`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function notifyDevicesComingSoon(action: string) {
  toastManager.add({
    id: "devices-coming-soon",
    type: "info",
    title: `${action} is coming soon`,
    description: "Devices is a preview on placeholder data.",
    timeout: 2500,
  });
}
