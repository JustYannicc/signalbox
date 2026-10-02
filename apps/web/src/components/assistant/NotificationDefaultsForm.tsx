/**
 * Body of Settings > Notifications: the default for when supervisor agents may
 * ping you, the rule for "important", and whether urgent things reach your
 * phone while you're away. The computer is always quiet, so it has no control.
 */
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  DEFAULT_NOTIFY_DEFAULTS,
  NOTIFY_DEVICE_NAMES,
  NOTIFY_POLICIES,
  NOTIFY_POLICY_DETAIL,
  NOTIFY_POLICY_LABEL,
  type NotifyDefaults,
} from "./notificationPolicy";

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
          description="Each agent's bell can change this."
          control={
            <Select
              value={value.policy}
              onValueChange={(next) => {
                const policy = NOTIFY_POLICIES.find((candidate) => candidate === next);
                if (policy) set({ policy });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Default for agents">
                <SelectValue>{NOTIFY_POLICY_LABEL[value.policy]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {NOTIFY_POLICIES.map((policy) => (
                  <SelectItem key={policy} hideIndicator value={policy}>
                    <span className="flex w-full items-center justify-between gap-4">
                      {NOTIFY_POLICY_LABEL[policy]}
                      <span className="text-xs text-muted-foreground">
                        {NOTIFY_POLICY_DETAIL[policy]}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
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

      <SettingsSection title="Where it lands">
        <SettingsRow
          title={`At your computer · ${NOTIFY_DEVICE_NAMES.computer}`}
          description="Always quiet: a badge and a sidebar marker. No sound."
        />
        <SettingsRow
          title={`Away · ${NOTIFY_DEVICE_NAMES.phone}`}
          description={value.phone ? "Urgent only." : "Off. Everything waits for you."}
          control={
            <Switch
              checked={value.phone}
              onCheckedChange={(phone) => set({ phone })}
              aria-label="Urgent things go to your phone while you're away"
            />
          }
        />
      </SettingsSection>
    </>
  );
}
