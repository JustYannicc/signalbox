/**
 * Codex & Claude plugins: each harness's own plugin marketplace, grouped by
 * harness. Only harnesses that have plugins show up.
 */
import { useState } from "react";

import { cn } from "~/lib/utils";

import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { GroupBadges } from "./groupPrimitives";
import { HARNESSES, type HarnessPlugin } from "./pluginsModel";
import { HARNESS_PLUGINS } from "./pluginsFixtures";
import { comingSoon, DEEP_LINK_ROW_CLASS, HarnessGlyph, useDeepLinkRow } from "./pluginsPrimitives";

function HarnessPluginRow(props: {
  plugin: HarnessPlugin;
  targeted: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { plugin } = props;
  const switchId = `harness-plugin-${plugin.id}`;
  const rowRef = useDeepLinkRow<HTMLDivElement>(props.targeted);
  return (
    <div
      ref={rowRef}
      className={cn(
        "flex items-center gap-4 px-3 py-3 sm:px-4",
        props.targeted && DEEP_LINK_ROW_CLASS,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <label htmlFor={switchId} className="truncate text-sm font-medium text-foreground">
            {plugin.name}
          </label>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {plugin.version}
          </span>
          <span className="text-xs text-muted-foreground">from {plugin.source}</span>
          <GroupBadges groups={plugin.groups} />
        </div>
        <p className="text-xs text-muted-foreground">{plugin.description}</p>
      </div>
      {plugin.updateAvailable ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => comingSoon(`Update ${plugin.name} to ${plugin.updateAvailable}`)}
        >
          Update to {plugin.updateAvailable}
        </Button>
      ) : null}
      <Switch id={switchId} checked={props.enabled} onCheckedChange={props.onEnabledChange} />
    </div>
  );
}

export function HarnessPluginsSection(props: { item?: string | undefined }) {
  const [enabledById, setEnabledById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(HARNESS_PLUGINS.map((plugin) => [plugin.id, plugin.enabled])),
  );
  const harnessesWithPlugins = HARNESSES.filter((harness) =>
    HARNESS_PLUGINS.some((plugin) => plugin.harness === harness.id),
  );

  return (
    <div className="flex flex-col gap-8">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Plugins from each harness's own marketplace; they load only in that harness.
      </p>
      {harnessesWithPlugins.map((harness) => {
        const plugins = HARNESS_PLUGINS.filter((plugin) => plugin.harness === harness.id);
        const enabledCount = plugins.filter((plugin) => enabledById[plugin.id]).length;
        return (
          <SettingsSection
            key={harness.id}
            title={harness.label}
            icon={<HarnessGlyph harness={harness.id} />}
            headerAction={
              <Badge variant="outline" size="sm">
                {enabledCount} of {plugins.length} on
              </Badge>
            }
          >
            {plugins.map((plugin) => (
              <HarnessPluginRow
                key={plugin.id}
                plugin={plugin}
                targeted={props.item === plugin.id}
                enabled={enabledById[plugin.id] ?? false}
                onEnabledChange={(enabled) =>
                  setEnabledById((current) => ({ ...current, [plugin.id]: enabled }))
                }
              />
            ))}
          </SettingsSection>
        );
      })}
    </div>
  );
}
