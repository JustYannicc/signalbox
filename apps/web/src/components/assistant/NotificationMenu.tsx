/** Header bell for the assistant and agent pages: when this agent may notify you. */
import { useNavigate } from "@tanstack/react-router";
import { BellDotIcon, BellIcon, BellOffIcon, SettingsIcon } from "lucide-react";

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
  const navigate = useNavigate();
  const [defaults] = useNotifyDefaults();
  const [policy, setPolicy, isOverridden] = useNotifyPolicy(props.agentKey);
  const Icon = POLICY_ICON[policy];
  const delivery = notifyDeliveryHint(policy, defaults.phone);
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
              <OptionRow label={`Default (${NOTIFY_POLICY_LABEL[defaults.policy]})`} />
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
          {notifyPolicyHint(policy, props.agentName)} {delivery}
        </p>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/notifications" })}>
          <SettingsIcon />
          Notification settings…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
