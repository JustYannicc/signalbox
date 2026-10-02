/**
 * Instructions: edit AGENTS.md per agent role and scope as blocks, each shown
 * to every harness or just one, next to the file a chosen role and harness
 * would receive. Role and scope come from the URL so agent pages can link in.
 */
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { groupById, ManagedNote } from "./groupPrimitives";
import { isRestricted } from "./groupsModel";
import { AudienceSwatch, InstructionBlockEditor } from "./InstructionBlockEditor";
import { INSTRUCTION_DOCS } from "./instructionsFixtures";
import {
  audienceLabel,
  docKey,
  instructionPath,
  newBlock,
  SCOPE_INFO,
  scopesFor,
  type InstructionAudience,
  type InstructionBlock,
  type InstructionRole,
  type InstructionScope,
} from "./instructionsModel";
import { InstructionsPreview } from "./InstructionsPreview";
import { RolePicker, SoulCard } from "./InstructionsRoles";
import { HARNESSES, type HarnessId } from "./pluginsModel";

/** Blocks keyed by docKey(role, scope); a missing key is an empty file. */
type BlocksByDoc = Readonly<Record<string, readonly InstructionBlock[]>>;

const INITIAL_BLOCKS: BlocksByDoc = Object.fromEntries(
  INSTRUCTION_DOCS.map((doc) => [docKey(doc.role, doc.scope), doc.blocks]),
);
const NO_BLOCKS: readonly InstructionBlock[] = [];
const AUDIENCES: readonly InstructionAudience[] = ["all", ...HARNESSES.map((entry) => entry.id)];

export function InstructionsSection(props: {
  role: InstructionRole;
  scope: InstructionScope;
  onNavigate: (next: { role: InstructionRole; scope: InstructionScope }) => void;
}) {
  const { role } = props;
  const scopes = scopesFor(role);
  // Supervisors only have a Personal file; a deep link to another scope lands there.
  const scope = scopes.includes(props.scope) ? props.scope : "personal";
  const [previewRole, setPreviewRole] = useState<InstructionRole>(role);
  const [previewHarness, setPreviewHarness] = useState<HarnessId>("claudeAgent");
  const [blocks, setBlocks] = useState<BlocksByDoc>(INITIAL_BLOCKS);
  const [saved, setSaved] = useState<BlocksByDoc>(INITIAL_BLOCKS);

  const key = docKey(role, scope);
  const path = instructionPath(scope, role);
  const groupId = SCOPE_INFO[scope].groupId;
  const group = groupId ? groupById(groupId) : undefined;
  const locked = group ? isRestricted(group, "instructions") : false;
  const current = blocks[key] ?? NO_BLOCKS;
  const dirty = current !== (saved[key] ?? NO_BLOCKS);
  const blocksIn = (entryRole: InstructionRole, entryScope: InstructionScope) =>
    blocks[docKey(entryRole, entryScope)] ?? NO_BLOCKS;

  const setCurrent = (next: readonly InstructionBlock[]) =>
    setBlocks((all) => ({ ...all, [key]: next }));
  const save = () => {
    setSaved((all) => ({ ...all, [key]: current }));
    toastManager.add({ title: `Saved ${path}`, timeout: 2000 });
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        One file per agent role, split into blocks for all harnesses or just one.
      </p>

      <div className="flex flex-col gap-4 px-3 sm:px-4">
        <RolePicker
          role={role}
          onChange={(next) => {
            setPreviewRole(next);
            props.onNavigate({ role: next, scope });
          }}
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {scopes.length > 1 ? (
            <ToggleGroup
              aria-label="Instruction scope"
              value={[scope]}
              onValueChange={(next) => {
                const value = scopes.find((entry) => entry === next[0]);
                if (value) props.onNavigate({ role, scope: value });
              }}
            >
              {scopes.map((entry) => (
                <Toggle key={entry} value={entry}>
                  {SCOPE_INFO[entry].label}
                </Toggle>
              ))}
            </ToggleGroup>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
            {locked && group ? <ManagedNote group={group} /> : null}
            {dirty ? (
              <Badge variant="outline" size="sm">
                Unsaved
              </Badge>
            ) : null}
          </div>
          {locked ? null : (
            <Button size="sm" disabled={!dirty} onClick={save}>
              Save
            </Button>
          )}
        </div>
      </div>

      {role === "assistant" ? <SoulCard /> : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-2">
          <div className="flex min-h-7 items-center gap-3 px-1">
            <h3 className="text-sm text-foreground/70">Blocks</h3>
            <span className="text-xs text-muted-foreground tabular-nums">{current.length}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card/40 p-1.5">
            {current.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Empty. Add a block for every harness or for one.
              </p>
            ) : null}
            {current.map((block) => (
              <InstructionBlockEditor
                key={block.id}
                block={block}
                readOnly={locked}
                onChange={(next) =>
                  setCurrent(current.map((entry) => (entry.id === next.id ? next : entry)))
                }
                onRemove={() => setCurrent(current.filter((entry) => entry.id !== block.id))}
              />
            ))}
            {locked ? null : (
              <Menu>
                <MenuTrigger
                  render={<Button size="xs" variant="ghost-muted" className="self-start" />}
                >
                  <PlusIcon aria-hidden />
                  Add block
                </MenuTrigger>
                <MenuPopup align="start">
                  {AUDIENCES.map((audience) => (
                    <MenuItem
                      key={audience}
                      onClick={() => setCurrent([...current, newBlock(audience)])}
                    >
                      <AudienceSwatch audience={audience} />
                      {audienceLabel(audience)}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            )}
          </div>
        </section>
        <InstructionsPreview
          role={previewRole}
          onRoleChange={setPreviewRole}
          harness={previewHarness}
          onHarnessChange={setPreviewHarness}
          blocksIn={blocksIn}
        />
      </div>
    </div>
  );
}
