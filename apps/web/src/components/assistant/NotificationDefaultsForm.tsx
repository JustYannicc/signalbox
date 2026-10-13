/**
 * Body of Settings > Notifications: the default for when supervisor agents may
 * ping you, the rule for "important", and where pings land: each client
 * device sits at a Home level and gets that level's pings, filtered by its
 * own setting (quiet badge, urgent only, off). Render everything here
 * inside a `LevelOptionsProvider`. `NotificationOverridesSection` lists the
 * rules agents' bells set per level.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";

import { useClientDevices } from "../devices/deviceLevelsStore";
import { DeviceNotifySelect } from "../devices/DeviceNotifySelect";
import { deliveryScopeLabel } from "../levels/delivery";
import {
  useLevelAgentName,
  useLevelLabel,
  useLevelOptionsContext,
} from "../levels/LevelOptionsProvider";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  DEFAULT_NOTIFY_DEFAULTS,
  NOTIFY_POLICIES,
  NOTIFY_POLICY_DETAIL,
  NOTIFY_POLICY_LABEL,
  type NotifyDefaults,
  type NotifyPolicy,
  useNotifyOverrides,
} from "./notificationPolicy";

function PolicySelect(props: {
  value: NotifyPolicy;
  onChange: (policy: NotifyPolicy) => void;
  label: string;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(next) => {
        const policy = NOTIFY_POLICIES.find((candidate) => candidate === next);
        if (policy) props.onChange(policy);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={props.label}>
        <SelectValue>{NOTIFY_POLICY_LABEL[props.value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {NOTIFY_POLICIES.map((policy) => (
          <SelectItem key={policy} hideIndicator value={policy}>
            <span className="flex w-full items-center justify-between gap-4">
              {NOTIFY_POLICY_LABEL[policy]}
              <span className="text-xs text-muted-foreground">{NOTIFY_POLICY_DETAIL[policy]}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function NotificationDefaultsForm(props: {
  value: NotifyDefaults;
  onChange: (value: NotifyDefaults) => void;
  assistantName: string;
}) {
  const { value } = props;
  const set = (patch: Partial<NotifyDefaults>) => props.onChange({ ...value, ...patch });

  return (
    <>
      <SettingsSection title="What's worth a ping">
        <SettingsRow
          title="Default for agents"
          description="Each agent's bell can change this for its folder and everything inside it."
          control={
            <PolicySelect
              value={value.policy}
              onChange={(policy) => set({ policy })}
              label="Default for agents"
            />
          }
        />
        {value.policy === "important" ? (
          <SettingsRow
            title="What counts as important"
            description={`Plain words work. You can also just tell ${props.assistantName} in chat.`}
          >
            <div className="pt-2 pb-2">
              <Textarea
                aria-label="What counts as important"
                size="sm"
                value={value.rule}
                placeholder={DEFAULT_NOTIFY_DEFAULTS.rule}
                onChange={(event) => set({ rule: event.currentTarget.value })}
              />
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <WhereItLands />
    </>
  );
}

/** Every client device by its level: what it gets pings about, and how. */
function WhereItLands() {
  const devices = useClientDevices();
  const levelLabel = useLevelLabel();
  return (
    <SettingsSection
      title="Where it lands"
      headerAction={
        <Button size="xs" variant="ghost-muted" render={<Link to="/devices" />}>
          Move devices
          <ArrowUpRightIcon aria-hidden />
        </Button>
      }
    >
      {devices.map((device) => (
        <SettingsRow
          key={device.id}
          title={`${device.name} · ${levelLabel(device.level)}`}
          description={`Pings about ${deliveryScopeLabel(device.level, levelLabel(device.level))}.`}
          control={<DeviceNotifySelect device={device} />}
        />
      ))}
    </SettingsSection>
  );
}

/** Rules set per level, in tree order; clearing one makes that level inherit again. */
export function NotificationOverridesSection() {
  const options = useLevelOptionsContext();
  const agentName = useLevelAgentName();
  const [overrides, setOverride] = useNotifyOverrides(options);
  const rows = options.flatMap((option) => {
    const policy = overrides[option.key];
    return policy ? [{ option, policy }] : [];
  });
  return (
    <SettingsSection title="Set per folder">
      {rows.length === 0 ? (
        <SettingsRow
          title="Everything follows the default"
          description="An agent's bell sets a rule for its folder. The nearest rule above wins."
        />
      ) : (
        rows.map(({ option, policy }) => (
          <SettingsRow
            key={option.key}
            title={option.label}
            description={
              option.kind === "project"
                ? `Set by ${agentName(option.key)}'s bell.`
                : `Set by ${agentName(option.key)}'s bell. Holds inside unless a folder there sets its own.`
            }
            resetAction={
              <SettingResetButton
                label={option.label}
                tooltip="Inherit again"
                onClick={() => setOverride(option.key, null)}
              />
            }
            control={
              <PolicySelect
                value={policy}
                onChange={(next) => setOverride(option.key, next)}
                label={`Notifications for ${option.label}`}
              />
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
