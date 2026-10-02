/**
 * A resolved preset by kind, with where each item comes from. Project
 * overrides (added or removed) are the rows that stand out.
 */
import { UserPlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import {
  DEFAULTS_KIND_LABEL,
  DEFAULTS_KINDS,
  type ResolvedItem,
  type ResolvedPreset,
} from "./defaultsModel";
import { HarnessGlyph, IntegrationMark } from "./pluginsPrimitives";

function ItemLead(props: { entry: ResolvedItem }) {
  const { item } = props.entry;
  if (item.glyph) return <IntegrationMark glyph={item.glyph} size="sm" />;
  if (item.harness) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center">
        <HarnessGlyph harness={item.harness} />
      </span>
    );
  }
  return <span aria-hidden className="size-5 shrink-0" />;
}

function OriginBadge(props: { entry: ResolvedItem; parentName: string | undefined }) {
  switch (props.entry.origin) {
    case "added":
      return (
        <Badge variant="info" size="sm">
          Added here
        </Badge>
      );
    case "removed":
      return (
        <Badge variant="warning" size="sm">
          Removed here
        </Badge>
      );
    case "inherited":
      return (
        <Badge variant="outline" size="sm">
          From {props.parentName}
        </Badge>
      );
    case "own":
      return null;
  }
}

function ItemRow(props: { entry: ResolvedItem; parentName: string | undefined }) {
  const { entry } = props;
  const { item } = entry;
  const removed = entry.origin === "removed";
  return (
    <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
      <ItemLead entry={entry} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-sm",
            removed ? "text-muted-foreground line-through" : "text-foreground",
            item.kind === "skills" && "font-mono",
          )}
        >
          {item.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
      </div>
      {item.connection === "own" ? (
        <Badge variant="outline" size="sm">
          <UserPlusIcon aria-hidden />
          {item.optional ? "Connect your own · optional" : "Connect your own"}
        </Badge>
      ) : item.connection === "shared" ? (
        <Badge variant="secondary" size="sm">
          Company account
        </Badge>
      ) : null}
      <OriginBadge entry={entry} parentName={props.parentName} />
    </div>
  );
}

export function DefaultsPresetList(props: { resolved: ResolvedPreset }) {
  const { resolved } = props;
  const parentName = resolved.parent?.name;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {DEFAULTS_KINDS.map((kind) => {
        const entries = resolved.items.filter((entry) => entry.item.kind === kind);
        return (
          <SettingsSection key={kind} title={DEFAULTS_KIND_LABEL[kind]}>
            {entries.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">None by default.</p>
            ) : (
              entries.map((entry) => (
                <ItemRow key={entry.item.id} entry={entry} parentName={parentName} />
              ))
            )}
          </SettingsSection>
        );
      })}
    </div>
  );
}
