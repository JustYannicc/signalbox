/**
 * AGENTS.md per level. Each level has one file with two audiences: the
 * level's agent (it coordinates the threads, tasks and automations there) and
 * the threads and tasks at the level. A file reaches `below` by default, so
 * its rules apply at its level and every level inside it; set it to `here` to
 * keep it to its own level. What one level gets is `resolveInstructions`:
 * inherited files from the top down, then its own, nearest winning when two
 * blocks share a heading. Each block goes to every harness or to one.
 */
import { canUse, levelChain, nearestOnChain, type LevelKey, type Reach } from "../levels/levels";
import { HARNESSES, type HarnessId } from "./pluginsModel";

export type InstructionHarness = "all" | HarnessId;

export interface InstructionBlock {
  readonly id: string;
  readonly harness: InstructionHarness;
  readonly text: string;
}

export type InstructionAudience = "agent" | "threads";
export const INSTRUCTION_AUDIENCES: readonly InstructionAudience[] = ["agent", "threads"];

export const AUDIENCE_LABEL: Record<InstructionAudience, string> = {
  agent: "Level agent",
  threads: "Threads here",
};

/** One level's AGENTS.md. */
export interface LevelInstructions {
  readonly level: LevelKey;
  readonly reach: Reach;
  readonly agent: readonly InstructionBlock[];
  readonly threads: readonly InstructionBlock[];
}

/** Files by level; a missing level has no AGENTS.md. */
export type InstructionDocs = Readonly<Record<LevelKey, LevelInstructions>>;

export function emptyInstructions(level: LevelKey): LevelInstructions {
  return { level, reach: "below", agent: [], threads: [] };
}

export function harnessLabel(harness: InstructionHarness) {
  if (harness === "all") return "All harnesses";
  return `${HARNESSES.find((entry) => entry.id === harness)?.label ?? harness} only`;
}

export function blocksFor(blocks: readonly InstructionBlock[], harness: HarnessId) {
  return blocks.filter((block) => block.harness === "all" || block.harness === harness);
}

/** Claude Code reads CLAUDE.md; the rest read AGENTS.md. */
export function instructionFileName(harness: HarnessId) {
  return harness === "claudeAgent" ? "CLAUDE.md" : "AGENTS.md";
}

export interface ResolvedBlock {
  readonly block: InstructionBlock;
  /** A nearer level's block with the same heading wins over this one. */
  readonly overriddenBy: LevelKey | null;
}

export interface InstructionSource {
  readonly level: LevelKey;
  /** False for the level's own file. */
  readonly inherited: boolean;
  readonly blocks: readonly ResolvedBlock[];
}

type Placement = Parameters<typeof levelChain>[1];

/** "## Voice" and "# voice" conflict; blocks without a heading never do. */
function headingKey(text: string): string | null {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  if (!first.startsWith("#")) return null;
  const key = first
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
  return key.length > 0 ? key : null;
}

/**
 * What one audience at `level` reads on `harness`: every file that reaches it
 * (per `canUse`), top first, each block marked when a nearer level's block
 * with the same heading overrides it. Files with nothing for this audience
 * and harness are left out.
 */
export function resolveInstructions(
  level: LevelKey,
  audience: InstructionAudience,
  harness: HarnessId,
  docs: InstructionDocs,
  placement?: Placement,
): readonly InstructionSource[] {
  const sources = levelChain(level, placement)
    .toReversed()
    .flatMap((sourceLevel) => {
      const doc = docs[sourceLevel];
      if (!doc || !canUse(level, sourceLevel, placement, doc.reach)) return [];
      const blocks = blocksFor(doc[audience], harness).filter((block) => block.text.trim());
      return blocks.length > 0 ? [{ level: sourceLevel, blocks }] : [];
    });

  const definedAt = new Map<string, LevelKey[]>();
  for (const source of sources) {
    for (const block of source.blocks) {
      const key = headingKey(block.text);
      if (key) definedAt.set(key, [...(definedAt.get(key) ?? []), source.level]);
    }
  }

  return sources.map((source) => ({
    level: source.level,
    inherited: source.level !== level,
    blocks: source.blocks.map((block) => {
      const key = headingKey(block.text);
      const winner = key ? nearestOnChain(level, definedAt.get(key) ?? [], placement) : null;
      return { block, overriddenBy: winner && winner !== source.level ? winner : null };
    }),
  }));
}

/** The file text one source contributes: its live blocks, overridden ones dropped. */
export function sourceText(source: InstructionSource): string {
  return source.blocks
    .filter((entry) => entry.overriddenBy === null)
    .map((entry) => entry.block.text.trim())
    .join("\n\n");
}

let newBlockCount = 0;

/** Ids only need to be unique within this page session. */
export function newBlock(harness: InstructionHarness): InstructionBlock {
  newBlockCount += 1;
  return { id: `block-new-${Date.now()}-${newBlockCount}`, harness, text: "" };
}
