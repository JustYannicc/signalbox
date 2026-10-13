/**
 * Editing one level's AGENTS.md. `useInstructionDraft(level)` holds unsaved
 * changes; render `InstructionsLevelHeader` (audience, reach, save) and
 * `InstructionsBlocks` from it, and pass the draft to `InstructionsPreview`
 * so the compiled view follows typing. Plugins › Instructions and the agent
 * page's Instructions dialog both use these; key them by level.
 */
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { AssistantIcon, useAssistantIdentity } from "../assistant/assistantIdentity";
import { useAssistantSoulState } from "../assistant/assistantSoul";
import { useLevelAgentName } from "../levels/LevelOptionsProvider";
import { TOP_LEVEL, type LevelKey, type Reach } from "../levels/levels";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { HARNESS_CHOICES, HarnessSwatch, InstructionBlockEditor } from "./InstructionBlockEditor";
import {
  AUDIENCE_LABEL,
  emptyInstructions,
  harnessLabel,
  INSTRUCTION_AUDIENCES,
  newBlock,
  type InstructionAudience,
  type InstructionBlock,
  type LevelInstructions,
} from "./instructionsModel";
import { useInstructionDocs, useInstructionsStore } from "./instructionsStore";
import { ManagedNote } from "./levelPrimitives";
import { LEVEL_POLICIES } from "./levelPolicyFixtures";
import { isRestricted, policyFor } from "./levelPolicyModel";

const SOUL_PREVIEW_LINES = 6;

export function useInstructionDraft(level: LevelKey) {
  const stored = useInstructionDocs()[level] ?? emptyInstructions(level);
  const [draft, setDraft] = useState<LevelInstructions | null>(null);
  const policy = policyFor(level, LEVEL_POLICIES);
  return {
    doc: draft ?? stored,
    dirty: draft !== null,
    locked: isRestricted(policy, "instructions"),
    policy,
    update: (next: LevelInstructions) => setDraft(next),
    save: () => {
      if (!draft) return;
      useInstructionsStore.getState().save(draft);
      setDraft(null);
      toastManager.add({ title: "Saved AGENTS.md", timeout: 2000 });
    },
  };
}

export type InstructionDraft = ReturnType<typeof useInstructionDraft>;

/** Who reads the open audience: the level's agent, or every thread and task here. */
function useAudienceLine(level: LevelKey, audience: InstructionAudience, reach: Reach) {
  const agentName = useLevelAgentName();
  const inside = reach === "below";
  if (audience === "agent") {
    return inside
      ? `Read by ${agentName(level)} and the agents of every folder inside.`
      : `Read by ${agentName(level)} only.`;
  }
  return inside
    ? "Read by every thread and task here and in every folder inside."
    : "Read by every thread and task at this level only.";
}

export function InstructionsLevelHeader(props: {
  level: LevelKey;
  draft: InstructionDraft;
  audience: InstructionAudience;
  onAudienceChange: (audience: InstructionAudience) => void;
}) {
  const { doc, dirty, locked, policy } = props.draft;
  const line = useAudienceLine(props.level, props.audience, doc.reach);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label="Who reads it"
          value={[props.audience]}
          onValueChange={(next) => {
            const value = INSTRUCTION_AUDIENCES.find((entry) => entry === next[0]);
            if (value) props.onAudienceChange(value);
          }}
        >
          {INSTRUCTION_AUDIENCES.map((audience) => (
            <Toggle key={audience} value={audience}>
              {AUDIENCE_LABEL[audience]}
              <span className="text-xs text-muted-foreground tabular-nums">
                {doc[audience].length}
              </span>
            </Toggle>
          ))}
        </ToggleGroup>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch
            checked={doc.reach === "below"}
            disabled={locked}
            onCheckedChange={(checked) =>
              props.draft.update({ ...doc, reach: checked ? "below" : "here" })
            }
          />
          Available to folders inside
        </label>
        <div className="ms-auto flex items-center gap-2">
          {locked && policy ? <ManagedNote policy={policy} /> : null}
          {dirty ? (
            <Badge variant="outline" size="sm">
              Unsaved
            </Badge>
          ) : null}
          {locked ? null : (
            <Button size="sm" disabled={!dirty} onClick={props.draft.save}>
              Save
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{line}</p>
    </div>
  );
}

export function InstructionsBlocks(props: {
  draft: InstructionDraft;
  audience: InstructionAudience;
}) {
  const { doc, locked } = props.draft;
  const blocks = doc[props.audience];
  const setBlocks = (next: readonly InstructionBlock[]) =>
    props.draft.update({ ...doc, [props.audience]: next });

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card/40 p-1.5">
      {blocks.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          Empty. Add a block for every harness or for one.
        </p>
      ) : null}
      {blocks.map((block) => (
        <InstructionBlockEditor
          key={block.id}
          block={block}
          readOnly={locked}
          onChange={(next) =>
            setBlocks(blocks.map((entry) => (entry.id === next.id ? next : entry)))
          }
          onRemove={() => setBlocks(blocks.filter((entry) => entry.id !== block.id))}
        />
      ))}
      {locked ? null : (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost-muted" className="self-start" />}>
            <PlusIcon aria-hidden />
            Add block
          </MenuTrigger>
          <MenuPopup align="start">
            {HARNESS_CHOICES.map((harness) => (
              <MenuItem key={harness} onClick={() => setBlocks([...blocks, newBlock(harness)])}>
                <HarnessSwatch harness={harness} />
                {harnessLabel(harness)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}

/** The assistant's read-only SOUL.md, beside the top level's agent instructions. */
export function SoulCard(props: { level: LevelKey; audience: InstructionAudience }) {
  const { name } = useAssistantIdentity();
  const [soul] = useAssistantSoulState();
  if (props.level !== TOP_LEVEL || props.audience !== "agent") return null;
  const excerpt = soul.split("\n").slice(0, SOUL_PREVIEW_LINES).join("\n");
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AssistantIcon size={20} />
        <h3 className="text-sm font-medium text-foreground">{name}'s SOUL.md</h3>
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          render={<Link to="/assistant" search={{ customize: "soul" }} />}
        >
          Edit in {name} › Customize
        </Button>
      </div>
      <pre className="rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
        {excerpt}
      </pre>
    </section>
  );
}
