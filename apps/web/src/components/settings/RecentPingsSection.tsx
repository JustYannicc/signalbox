/**
 * Settings › Notifications: the last few pings and where each landed, as
 * Focus is right now. Pings about levels Focus hides aren't listed at all
 * (out of sight, out of mind) unless an escalation rule broke through.
 * Render inside a `LevelOptionsProvider`. PLACEHOLDER: fixture pings.
 */
import { useMemo } from "react";

import {
  demoPersonalProject,
  useNotifyDefaults,
  useNotifyOverrides,
} from "../assistant/notificationPolicy";
import { useClientDevices } from "../devices/deviceLevelsStore";
import { joinWords, useEscalationStore } from "../levels/escalation";
import { useLevelLabel, useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { recentPings, routePing, type Ping, type PingRoute } from "../levels/recentPings";
import { focusLabel } from "../sidebar/focus/focusLevels";
import { useFocusedLevel } from "../sidebar/focus/focusStore";
import { Badge } from "../ui/badge";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function RecentPingsSection() {
  const options = useLevelOptionsContext();
  const levelLabel = useLevelLabel();
  const focus = useFocusedLevel();
  const devices = useClientDevices();
  const rules = useEscalationStore((state) => state.rules);
  const [defaults] = useNotifyDefaults();
  const [overrides] = useNotifyOverrides(options);
  const project = useMemo(() => demoPersonalProject(options), [options]);
  const rows = useMemo(() => {
    const context = { devices, focus, rules, overrides, fallback: defaults.policy };
    return recentPings(project?.key ?? null, project?.name).flatMap((ping) => {
      const route = routePing(ping, context);
      return route.kind === "hidden" ? [] : [{ ping, route }];
    });
  }, [defaults.policy, devices, focus, overrides, project, rules]);

  return (
    <SettingsSection title={`Recent pings · ${focusLabel(focus)}`}>
      {rows.map(({ ping, route }) => (
        <SettingsRow
          key={ping.id}
          title={ping.title}
          description={`${levelLabel(ping.level)} · ${ping.ago}. ${outcome(ping, route, levelLabel)}`}
          control={
            route.kind === "landed" && route.brokeThrough ? (
              <Badge variant="warning">Broke through Focus</Badge>
            ) : route.kind === "muted" ? (
              <Badge variant="outline">Muted</Badge>
            ) : null
          }
        />
      ))}
    </SettingsSection>
  );
}

function outcome(
  ping: Ping,
  route: Exclude<PingRoute<{ readonly name: string }>, { kind: "hidden" }>,
  levelLabel: (key: string) => string,
): string {
  if (route.kind === "muted") {
    return route.from === ping.level
      ? "Stayed in the chat: muted here."
      : `Stayed in the chat: ${levelLabel(route.from)} is muted.`;
  }
  const names = joinWords(route.devices.map((device) => device.name));
  if (!names) return "No device took it; it waits in the app.";
  const rule = route.escalatedBy[0];
  if (route.brokeThrough && rule) {
    return `Its folder is out of sight, but the rule at ${levelLabel(rule.level)} sent it to ${names}.`;
  }
  return `Landed on ${names}.`;
}
