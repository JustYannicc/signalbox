import { LaptopIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { deliveryScopeLabel } from "../levels/delivery";
import { useLevelAgentName, useLevelLabel } from "../levels/LevelOptionsProvider";
import { TOP_LEVEL } from "../levels/levels";
import { LevelSelectMenu } from "../levels/LevelSelectMenu";
import { Badge } from "../ui/badge";
import { MenuCheckboxItem, MenuSeparator } from "../ui/menu";
import { Switch } from "../ui/switch";
import { DeviceNotifySelect } from "./DeviceNotifySelect";
import {
  CAPABILITY_GROUP_LABEL,
  type CapabilityGroup,
  type ClientDevice,
  type GatewayCapability,
} from "./devicesModel";
import { useDeviceLevelsStore } from "./deviceLevelsStore";

const GROUP_ORDER: readonly CapabilityGroup[] = ["files", "device", "signals"];

const KIND_ICON = {
  laptop: LaptopIcon,
  desktop: MonitorIcon,
  phone: SmartphoneIcon,
} satisfies Record<ClientDevice["kind"], unknown>;

/**
 * A client is a gateway: servers reach into it for files, screenshots and
 * signals, but no turn ever executes on it. It sits at a Home level, which
 * decides what it gets pinged about and which agents may use its gateways.
 * Render inside a `LevelOptionsProvider`.
 */
export function ClientDeviceCard({ device }: { readonly device: ClientDevice }) {
  const levelLabel = useLevelLabel();
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(device.capabilities.map((cap) => [cap.id, cap.enabled])),
  );
  const Icon = KIND_ICON[device.kind];

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4">
      <header className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{device.name}</h3>
            {device.thisDevice ? (
              <span className="text-xs text-muted-foreground">This device</span>
            ) : null}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {device.activeNow ? (
              <>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
                <span className="text-foreground">Active now</span>
              </>
            ) : (
              <span>Last seen {device.lastSeen.toLowerCase()}</span>
            )}
            <span aria-hidden>·</span>
            <span className="truncate">{device.os}</span>
          </span>
        </div>
        <Badge variant="outline">Client · never runs work</Badge>
      </header>

      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-foreground">Sits at</span>
          <span className="text-xs text-muted-foreground">
            Pings about {deliveryScopeLabel(device.level, levelLabel(device.level))}
          </span>
        </span>
        <DeviceLevelMenu device={device} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-foreground">Notifications</span>
          <span className="text-xs text-muted-foreground">
            {device.activeNow ? "Pings go here first while you're on it" : "Used when you're away"}
          </span>
        </span>
        <DeviceNotifySelect device={device} variant="ghost" />
      </div>

      <div className="flex flex-col gap-3">
        <GatewayAccessHint device={device} />
        {GROUP_ORDER.map((group) => {
          const caps = device.capabilities.filter((cap) => cap.group === group);
          if (caps.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{CAPABILITY_GROUP_LABEL[group]}</span>
              <ul className="flex flex-col">
                {caps.map((cap) => (
                  <CapabilityRow
                    key={cap.id}
                    deviceId={device.id}
                    capability={cap}
                    checked={cap.unavailable === undefined && (enabled[cap.id] ?? false)}
                    onCheckedChange={(checked) =>
                      setEnabled((current) => ({ ...current, [cap.id]: checked }))
                    }
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function DeviceLevelMenu({ device }: { readonly device: ClientDevice }) {
  const setLevel = useDeviceLevelsStore((state) => state.setLevel);
  const setReach = useDeviceLevelsStore((state) => state.setReach);
  return (
    <LevelSelectMenu
      label={`Level for ${device.name}`}
      value={device.level}
      onChange={(level) => setLevel(device.id, level)}
    >
      <MenuSeparator />
      <MenuCheckboxItem
        checked={device.reach === "below"}
        onCheckedChange={(checked) => setReach(device.id, checked ? "below" : "here")}
      >
        Gateways available to folders inside
      </MenuCheckboxItem>
    </LevelSelectMenu>
  );
}

/** Who may use this device's gateways, by the usual level rules. */
function GatewayAccessHint({ device }: { readonly device: ClientDevice }) {
  const levelLabel = useLevelLabel();
  const agentName = useLevelAgentName();
  if (device.level === TOP_LEVEL) {
    return (
      <p className="text-xs text-muted-foreground">
        At the top level: only {agentName(TOP_LEVEL)} uses these. Folders ask it.
      </p>
    );
  }
  const who =
    device.reach === "below"
      ? `Agents in ${levelLabel(device.level)} and every folder inside`
      : `${agentName(device.level)} and the agents above it`;
  return (
    <p className="text-xs text-muted-foreground">
      {who} can use these. Anyone else asks the agent above.
    </p>
  );
}

function CapabilityRow({
  deviceId,
  capability,
  checked,
  onCheckedChange,
}: {
  readonly deviceId: string;
  readonly capability: GatewayCapability;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const id = `${deviceId}-${capability.id}`;
  const unavailable = capability.unavailable !== undefined;
  return (
    <li className="flex min-h-8 items-center gap-3">
      <label htmlFor={id} className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn(
            "text-sm",
            capability.label.startsWith("~") && "font-mono text-xs",
            unavailable ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {capability.label}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {capability.unavailable ?? capability.detail}
        </span>
      </label>
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={unavailable}
        onCheckedChange={onCheckedChange}
      />
    </li>
  );
}
