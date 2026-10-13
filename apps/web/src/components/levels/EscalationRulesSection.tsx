/**
 * Settings › Notifications: escalation rules, what may break through Focus and
 * to which devices. Each rule sits at a level and holds there and inside.
 * Render inside a `LevelOptionsProvider`; rules live in `escalation.ts`.
 */
import { BellRingIcon, PlusIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";

import { useClientDevices } from "../devices/deviceLevelsStore";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import {
  describeEscalation,
  ESCALATION_STATUS_LABEL,
  ESCALATION_STATUSES,
  joinWords,
  useEscalationStore,
  type EscalationRule,
} from "./escalation";
import { useLevelLabel, useLevelOptionsContext } from "./LevelOptionsProvider";
import { TOP_LEVEL } from "./levels";
import { LevelSelectMenu } from "./LevelSelectMenu";

/** Adds or removes `value`, keeping `order`. */
function toggled<T>(order: readonly T[], current: readonly T[], value: T, on: boolean): T[] {
  return order.filter((entry) => (entry === value ? on : current.includes(entry)));
}

export function EscalationRulesSection() {
  const rules = useEscalationStore((state) => state.rules);
  const addRule = useEscalationStore((state) => state.addRule);
  const options = useLevelOptionsContext();
  const devices = useClientDevices();
  const phone = devices.find((device) => device.kind === "phone");
  return (
    <SettingsSection
      title="Breaks through Focus"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            addRule({
              id: `rule-${Date.now()}`,
              level: options.find((option) => option.key !== TOP_LEVEL)?.key ?? TOP_LEVEL,
              statuses: ["approval", "failed"],
              deviceIds: phone ? [phone.id] : [],
            })
          }
        >
          <PlusIcon aria-hidden />
          Add rule
        </Button>
      }
    >
      {rules.length === 0 ? (
        <SettingsRow
          title="Out of sight stays out of mind"
          description="Add a rule to let approvals or failures in a folder reach you while Focus hides it."
        />
      ) : (
        rules.map((rule) => <RuleRow key={rule.id} rule={rule} />)
      )}
    </SettingsSection>
  );
}

function RuleRow({ rule }: { rule: EscalationRule }) {
  const updateRule = useEscalationStore((state) => state.updateRule);
  const removeRule = useEscalationStore((state) => state.removeRule);
  const devices = useClientDevices();
  const levelLabel = useLevelLabel();
  const label = levelLabel(rule.level);
  const deviceIds = devices.map((device) => device.id);
  const deviceName = (id: string) => devices.find((device) => device.id === id)?.name ?? id;
  return (
    <SettingsRow
      title={label}
      description={`${describeEscalation(rule, deviceName)} Holds here and inside.`}
      control={
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label={`Remove the rule for ${label}`}
          onClick={() => removeRule(rule.id)}
        >
          <Trash2Icon aria-hidden />
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-1 pb-2">
        <LevelSelectMenu
          label={`Level for the rule at ${label}`}
          value={rule.level}
          onChange={(level) => updateRule(rule.id, { level })}
        />
        <Menu>
          <MenuTrigger
            render={
              <Button size="xs" variant="ghost" aria-label={`What breaks through at ${label}`} />
            }
          >
            <BellRingIcon aria-hidden />
            {rule.statuses.length > 0
              ? joinWords(rule.statuses.map((status) => ESCALATION_STATUS_LABEL[status]))
              : "Nothing"}
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Breaks through</MenuGroupLabel>
              {ESCALATION_STATUSES.map((status) => (
                <MenuCheckboxItem
                  key={status}
                  checked={rule.statuses.includes(status)}
                  onCheckedChange={(on) =>
                    updateRule(rule.id, {
                      statuses: toggled(ESCALATION_STATUSES, rule.statuses, status, on),
                    })
                  }
                >
                  {ESCALATION_STATUS_LABEL[status]}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button size="xs" variant="ghost" aria-label={`Devices it reaches from ${label}`} />
            }
          >
            <SmartphoneIcon aria-hidden />
            {rule.deviceIds.length > 0 ? joinWords(rule.deviceIds.map(deviceName)) : "No device"}
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Reaches</MenuGroupLabel>
              {devices.map((device) => (
                <MenuCheckboxItem
                  key={device.id}
                  checked={rule.deviceIds.includes(device.id)}
                  onCheckedChange={(on) =>
                    updateRule(rule.id, {
                      deviceIds: toggled(deviceIds, rule.deviceIds, device.id, on),
                    })
                  }
                >
                  {device.name}
                </MenuCheckboxItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
    </SettingsRow>
  );
}
