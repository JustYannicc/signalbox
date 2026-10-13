/**
 * A level's "What newcomers get" tab: the preset at that level, so joining a
 * team or continuing a project needs no setup beyond connecting your own
 * accounts. A level starts from the nearest preset above it and lists only
 * what it changes.
 */
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";

import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DEFAULTS_PRESETS } from "./defaultsFixtures";
import { presetKind, resolvePreset, type DefaultsPreset } from "./defaultsModel";
import { DefaultsPresetList } from "./DefaultsPresetList";
import { ManagedNote } from "./levelPrimitives";
import { isRestricted, type LevelPolicy } from "./levelPolicyModel";
import { NewcomerPreview } from "./NewcomerPreview";
import { comingSoon } from "./pluginsPrimitives";

export function presetsAt(level: string): readonly DefaultsPreset[] {
  return DEFAULTS_PRESETS.filter((preset) => preset.level === level);
}

export function LevelNewcomers(props: { preset: DefaultsPreset; policy: LevelPolicy | undefined }) {
  const { preset } = props;
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const resolved = resolvePreset(preset, DEFAULTS_PRESETS, { projectSectionOverrides });
  const locked = isRestricted(props.policy, "defaults");
  const chain = resolved.parent ? [resolved.parent.name, preset.name] : [preset.name];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 px-3 sm:flex-row sm:items-center sm:px-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
          {chain.map((name, index) => (
            <Fragment key={name}>
              {index > 0 ? (
                <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
              ) : null}
              <span
                className={index === chain.length - 1 ? "text-foreground" : "text-muted-foreground"}
              >
                {name}
              </span>
            </Fragment>
          ))}
          <Badge variant="outline" size="sm">
            {presetKind(preset) === "team" ? "Team" : "Project"}
          </Badge>
          {resolved.parent ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {resolved.overrideCount === 0
                ? "No overrides"
                : `${resolved.overrideCount} ${resolved.overrideCount === 1 ? "override" : "overrides"}`}
            </span>
          ) : null}
        </div>
        {locked && props.policy ? (
          <ManagedNote policy={props.policy} />
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

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <DefaultsPresetList resolved={resolved} />
        <NewcomerPreview resolved={resolved} />
      </div>
    </div>
  );
}
