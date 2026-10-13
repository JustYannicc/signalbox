/**
 * Instructions: every level's AGENTS.md in one index, in Home tree order,
 * with the open level's editor beside what its agent or threads actually
 * read. Each level's agent page edits the same files. The `role` link param
 * only picks the audience; the open level lives in `instructionsStore`.
 */
import { useState } from "react";

import { useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import type { LevelKey } from "../levels/levels";
import type { LevelOption } from "../levels/levelOptions";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "~/lib/utils";
import { type InstructionAudience, type InstructionDocs } from "./instructionsModel";
import {
  InstructionsBlocks,
  InstructionsLevelHeader,
  SoulCard,
  useInstructionDraft,
} from "./InstructionsLevelEditor";
import { InstructionsPreview } from "./InstructionsPreview";
import { useInstructionDocs, useInstructionsStore } from "./instructionsStore";
import type { HarnessId } from "./pluginsModel";

function hasFile(docs: InstructionDocs, level: LevelKey) {
  const doc = docs[level];
  return doc !== undefined && doc.agent.length + doc.threads.length > 0;
}

function LevelIndexRow(props: {
  option: LevelOption;
  docs: InstructionDocs;
  selected: boolean;
  onSelect: () => void;
}) {
  const doc = props.docs[props.option.key];
  return (
    <li>
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onSelect}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-1.5 text-start text-sm hover:bg-accent/40",
          props.selected && "bg-accent/60",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-foreground">{props.option.label}</span>
        {doc ? (
          <>
            {doc.reach === "here" ? (
              <Badge variant="outline" size="sm">
                This level only
              </Badge>
            ) : null}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              Agent {doc.agent.length} · Threads {doc.threads.length}
            </span>
          </>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">No AGENTS.md yet</span>
        )}
      </button>
    </li>
  );
}

function LevelEditor(props: {
  level: LevelKey;
  audience: InstructionAudience;
  onAudienceChange: (audience: InstructionAudience) => void;
}) {
  const draft = useInstructionDraft(props.level);
  const [harness, setHarness] = useState<HarnessId>("claudeAgent");
  return (
    <div className="flex flex-col gap-4">
      <InstructionsLevelHeader
        level={props.level}
        draft={draft}
        audience={props.audience}
        onAudienceChange={props.onAudienceChange}
      />
      <SoulCard level={props.level} audience={props.audience} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <InstructionsBlocks draft={draft} audience={props.audience} />
        <InstructionsPreview
          level={props.level}
          audience={props.audience}
          harness={harness}
          onHarnessChange={setHarness}
          draft={draft.doc}
        />
      </div>
    </div>
  );
}

export function InstructionsSection(props: {
  /** From the URL (`?level=`); wins over the last level opened here. */
  level?: LevelKey | undefined;
  audience: InstructionAudience;
  onNavigate?: (next: { level: LevelKey; audience: InstructionAudience }) => void;
}) {
  const options = useLevelOptionsContext();
  const docs = useInstructionDocs();
  const lastOpened = useInstructionsStore((state) => state.openLevel);
  const openLevel = props.level ?? lastOpened;
  const { audience } = props;
  const open = (level: LevelKey) => {
    useInstructionsStore.getState().open(level);
    props.onNavigate?.({ level, audience });
  };
  const listed = options.filter((option) => option.key === openLevel || hasFile(docs, option.key));
  const opened = options.find((option) => option.key === openLevel) ?? options[0];

  return (
    <div className="flex flex-col gap-6">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        One AGENTS.md per level, for its agent and for the threads there. Rules reach every folder
        inside unless a level keeps them to itself; the nearer level wins on the same heading.
      </p>

      <section className="flex flex-col gap-2 px-3 sm:px-4">
        <div className="flex min-h-7 items-center gap-3">
          <h3 className="text-sm text-foreground/70">Levels</h3>
          <Select
            value={opened?.key ?? null}
            onValueChange={(value) => {
              if (typeof value === "string") open(value);
            }}
          >
            <SelectTrigger size="xs" variant="ghost" aria-label="Open a level" className="ms-auto">
              <SelectValue>Open another level</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <ul className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/40 p-1.5">
          {listed.map((option) => (
            <LevelIndexRow
              key={option.key}
              option={option}
              docs={docs}
              selected={option.key === opened?.key}
              onSelect={() => open(option.key)}
            />
          ))}
        </ul>
      </section>

      {opened ? (
        <section className="flex flex-col gap-3 px-3 sm:px-4">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{opened.label}</h2>
          <LevelEditor
            key={opened.key}
            level={opened.key}
            audience={audience}
            onAudienceChange={(next) => props.onNavigate?.({ level: opened.key, audience: next })}
          />
        </section>
      ) : null}
    </div>
  );
}
