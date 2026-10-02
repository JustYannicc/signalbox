/**
 * "Preview as newcomer": what someone opening this project for the first
 * time gets automatically, and the accounts only they can connect.
 */
import { CheckIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  DEFAULTS_KIND_LABEL,
  DEFAULTS_KINDS,
  newcomerSplit,
  type ResolvedPreset,
} from "./defaultsModel";
import { comingSoon, IntegrationMark } from "./pluginsPrimitives";

export function NewcomerPreview(props: { resolved: ResolvedPreset }) {
  const { ready, toConnect } = newcomerSplit(props.resolved);
  const required = toConnect.filter((entry) => !entry.item.optional);

  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border/60 bg-card/40 p-4 lg:sticky lg:top-4 lg:self-start">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">Preview as newcomer</h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {ready.length} ready on first open · {required.length} to connect
          {toConnect.length > required.length
            ? ` · ${toConnect.length - required.length} optional`
            : ""}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">You connect</h4>
        {toConnect.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing. Everything is shared.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {toConnect.map(({ item }) => (
              <li key={item.id} className="flex items-center gap-2.5">
                {item.glyph ? <IntegrationMark glyph={item.glyph} size="sm" /> : null}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">{item.name}</span>
                  {item.optional ? (
                    <span className="text-xs text-muted-foreground">Optional</span>
                  ) : null}
                </span>
                <Button
                  size="xs"
                  variant={item.optional ? "ghost" : "outline"}
                  onClick={() => comingSoon(`Connect your ${item.name}`)}
                >
                  Connect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">Ready automatically</h4>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          {DEFAULTS_KINDS.map((kind) => {
            const names = ready
              .filter((entry) => entry.item.kind === kind)
              .map((entry) => entry.item.name);
            return names.length === 0 ? null : (
              <div key={kind} className="contents">
                <dt className="text-muted-foreground">{DEFAULTS_KIND_LABEL[kind]}</dt>
                <dd className="flex items-start gap-1.5 text-foreground">
                  <CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-success" />
                  {names.join(", ")}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
