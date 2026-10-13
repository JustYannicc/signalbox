/**
 * Header bell for the assistant and agent pages: when this agent may notify
 * you. It sets the rule for the agent's level, so it also holds below it
 * unless a lower level sets its own. Agents without a level get no bell.
 * The hint names the devices this level's pings land on and the escalation
 * rules that hold here.
 */
import { useNavigate } from "@tanstack/react-router";
import { BellDotIcon, BellIcon, BellOffIcon, SettingsIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientDevices } from "../devices/deviceLevelsStore";
import { devicesFor } from "../levels/delivery";
import { describeEscalation, rulesAt, useEscalationStore } from "../levels/escalation";

import {
  LevelOptionsProvider,
  useLevelLabel,
  useLevelOptionsContext,
} from "../levels/LevelOptionsProvider";
import { TOP_LEVEL } from "../levels/levels";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  agentLevel,
  NOTIFY_POLICIES,
  NOTIFY_POLICY_DETAIL,
  NOTIFY_POLICY_LABEL,
  notifyDeliveryHint,
  notifyPolicyHint,
  useNotifyDefaults,
  useNotifyPolicy,
} from "./notificationPolicy";

const POLICY_ICON = { all: BellIcon, important: BellDotIcon, none: BellOffIcon } as const;
const DEFAULT_VALUE = "default";

function OptionRow(props: { label: string; detail?: string }) {
  return (
    <span className="flex min-w-56 items-center justify-between gap-6">
      {props.label}
      {props.detail ? <span className="text-xs text-muted-foreground">{props.detail}</span> : null}
    </span>
  );
}

export function NotificationMenu(props: { agentKey: string; agentName: string }) {
  return (
    <LevelOptionsProvider>
      <LevelNotificationMenu {...props} />
    </LevelOptionsProvider>
  );
}

function LevelNotificationMenu(props: { agentKey: string; agentName: string }) {
  const options = useLevelOptionsContext();
  const level = agentLevel(props.agentKey, options);
  if (level === null) return null;
  return <PolicyMenu {...props} level={level} />;
}

function PolicyMenu(props: { agentName: string; level: string }) {
  const navigate = useNavigate();
  const options = useLevelOptionsContext();
  const levelLabel = useLevelLabel();
  const [defaults] = useNotifyDefaults();
  const [policy, setPolicy, isOverridden, inherited] = useNotifyPolicy(props.level, options);
  const Icon = POLICY_ICON[policy];
  const devices = useClientDevices();
  const rules = useEscalationStore((state) => state.rules);
  // Routing as set, whatever Focus hides right now.
  const routed = useMemo(() => devicesFor(props.level, devices, TOP_LEVEL), [devices, props.level]);
  const escalations = useMemo(() => rulesAt(props.level, rules), [props.level, rules]);
  const deviceName = (id: string) => devices.find((device) => device.id === id)?.name ?? id;
  const delivery = notifyDeliveryHint(policy, defaults.phone, routed);
  const inheritLabel = inherited.from
    ? `Same as ${levelLabel(inherited.from)} (${NOTIFY_POLICY_LABEL[inherited.policy]})`
    : `Default (${NOTIFY_POLICY_LABEL[inherited.policy]})`;
  const isProject = options.find((option) => option.key === props.level)?.kind === "project";
  const scope = isProject
    ? ""
    : props.level === TOP_LEVEL
      ? "Holds everywhere unless a folder sets its own."
      : `Holds inside ${levelLabel(props.level)} unless a folder there sets its own.`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Notifications: ${NOTIFY_POLICY_LABEL[policy]}`}
                />
              }
            />
          }
        >
          <Icon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Notifications: {NOTIFY_POLICY_LABEL[policy]}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Notify me about</MenuGroupLabel>
          <MenuRadioGroup
            value={isOverridden ? policy : DEFAULT_VALUE}
            onValueChange={(value) => {
              if (value === DEFAULT_VALUE) return setPolicy(null);
              const next = NOTIFY_POLICIES.find((candidate) => candidate === value);
              if (next) setPolicy(next);
            }}
          >
            <MenuRadioItem value={DEFAULT_VALUE}>
              <OptionRow label={inheritLabel} />
            </MenuRadioItem>
            {NOTIFY_POLICIES.map((option) => (
              <MenuRadioItem key={option} value={option}>
                <OptionRow
                  label={NOTIFY_POLICY_LABEL[option]}
                  detail={NOTIFY_POLICY_DETAIL[option]}
                />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <p className="max-w-64 px-2 pt-1 pb-1.5 text-xs text-muted-foreground text-pretty">
          {notifyPolicyHint(policy, props.agentName)} {scope} {delivery}
        </p>
        {escalations.map((rule) => (
          <p
            key={rule.id}
            className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground text-pretty"
          >
            {rule.level === props.level ? "Here" : levelLabel(rule.level)}:{" "}
            {describeEscalation(rule, deviceName)}
          </p>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/notifications" })}>
          <SettingsIcon />
          Notification settings…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
