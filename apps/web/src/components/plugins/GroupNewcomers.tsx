/**
 * A group's "What newcomers get" tab: the team preset and each project's,
 * so continuing a project needs no setup beyond connecting your own
 * accounts. Projects start from their team and list only what they change.
 */
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { DEFAULTS_PRESETS } from "./defaultsFixtures";
import { resolvePreset } from "./defaultsModel";
import { DefaultsPresetList } from "./DefaultsPresetList";
import { ManagedNote } from "./groupPrimitives";
import { isRestricted, type AccessGroup } from "./groupsModel";
import { NewcomerPreview } from "./NewcomerPreview";
import { comingSoon } from "./pluginsPrimitives";

export function GroupNewcomers(props: { group: AccessGroup; presetId: string | undefined }) {
  const presets = DEFAULTS_PRESETS.filter((preset) => preset.groupId === props.group.id);
  const [selectedId, setSelectedId] = useState(
    presets.find((preset) => preset.id === props.presetId)?.id ?? presets[0]?.id,
  );
  const preset = presets.find((entry) => entry.id === selectedId) ?? presets[0];
  if (!preset) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        No defaults yet. Newcomers start empty.
      </p>
    );
  }
  const resolved = resolvePreset(preset, DEFAULTS_PRESETS);
  const locked = isRestricted(props.group, "defaults");
  const chain = resolved.parent ? [resolved.parent.name, preset.name] : [preset.name];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        {presets.length > 1 ? (
          <ToggleGroup
            aria-label="Team or project"
            value={[preset.id]}
            onValueChange={(next) => {
              if (next[0]) setSelectedId(next[0]);
            }}
            className="flex-wrap"
          >
            {presets.map((entry) => (
              <Toggle key={entry.id} value={entry.id}>
                {entry.name}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
            {chain.map((name, index) => (
              <Fragment key={name}>
                {index > 0 ? (
                  <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                ) : null}
                <span
                  className={
                    index === chain.length - 1 ? "text-foreground" : "text-muted-foreground"
                  }
                >
                  {name}
                </span>
              </Fragment>
            ))}
            <Badge variant="outline" size="sm">
              {preset.kind === "team" ? "Team" : "Project"}
            </Badge>
            {resolved.parent ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {resolved.overrideCount === 0
                  ? "No overrides"
                  : `${resolved.overrideCount} ${resolved.overrideCount === 1 ? "override" : "overrides"}`}
              </span>
            ) : null}
          </div>
          {locked ? (
            <ManagedNote group={props.group} />
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => comingSoon(`Edit ${preset.name} defaults`)}
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <DefaultsPresetList resolved={resolved} />
        <NewcomerPreview resolved={resolved} />
      </div>
    </div>
  );
}
