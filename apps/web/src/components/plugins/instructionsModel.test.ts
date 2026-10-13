import { describe, expect, it } from "vite-plus/test";

import { TOP_LEVEL } from "../levels/levels";
import {
  resolveInstructions,
  sourceText,
  type InstructionBlock,
  type InstructionDocs,
  type LevelInstructions,
} from "./instructionsModel";

const WORK = "section:work";
const NORTHWIND = "section:work-northwind";
const PERSONAL = "section:personal";
const PORTAL = "team-project:merchant-portal";

const block = (id: string, text: string, harness: InstructionBlock["harness"] = "all") => ({
  id,
  harness,
  text,
});

const doc = (
  level: string,
  threads: readonly InstructionBlock[],
  extra: Partial<LevelInstructions> = {},
): LevelInstructions => ({ level, reach: "below", agent: [], threads, ...extra });

const DOCS: InstructionDocs = Object.fromEntries(
  [
    doc(TOP_LEVEL, [block("top-voice", "## Voice\n\nShort."), block("top-plain", "Be honest.")], {
      agent: [block("top-agent", "# Coordinate")],
    }),
    doc(WORK, [block("work-only", "# Work only")], { reach: "here" }),
    doc(NORTHWIND, [
      block("nw-voice", "# voice\n\nFor teammates."),
      block("nw-cursor", "Composer.", "cursor"),
    ]),
    doc(PORTAL, [block("portal", "# Portal")]),
    doc(PERSONAL, [block("personal", "# Personal")]),
  ].map((entry) => [entry.level, entry]),
);

const ids = (sources: ReturnType<typeof resolveInstructions>) =>
  sources.flatMap((source) => source.blocks.map((entry) => entry.block.id));

describe("resolveInstructions", () => {
  it("gives a project's threads every file that reaches it, top first, labelled by level", () => {
    const sources = resolveInstructions(PORTAL, "threads", "claudeAgent", DOCS);
    expect(sources.map((source) => source.level)).toEqual([TOP_LEVEL, NORTHWIND, PORTAL]);
    expect(sources.map((source) => source.inherited)).toEqual([true, true, false]);
  });

  it("keeps a file set to reach `here` at its own level", () => {
    expect(ids(resolveInstructions(WORK, "threads", "codex", DOCS))).toContain("work-only");
    expect(ids(resolveInstructions(NORTHWIND, "threads", "codex", DOCS))).not.toContain(
      "work-only",
    );
  });

  it("never reaches a sibling branch", () => {
    expect(ids(resolveInstructions(PORTAL, "threads", "codex", DOCS))).not.toContain("personal");
    expect(ids(resolveInstructions(PERSONAL, "threads", "codex", DOCS))).not.toContain("nw-voice");
  });

  it("lets the nearest level win when two blocks share a heading", () => {
    const sources = resolveInstructions(PORTAL, "threads", "claudeAgent", DOCS);
    const top = sources[0]!;
    expect(top.blocks.find((entry) => entry.block.id === "top-voice")?.overriddenBy).toBe(
      NORTHWIND,
    );
    expect(sourceText(top)).toBe("Be honest.");
    // At the top level itself nothing overrides it.
    const own = resolveInstructions(TOP_LEVEL, "threads", "claudeAgent", DOCS)[0]!;
    expect(own.blocks.every((entry) => entry.overriddenBy === null)).toBe(true);
  });

  it("keeps the audiences apart and filters by harness", () => {
    expect(ids(resolveInstructions(PORTAL, "agent", "cursor", DOCS))).toEqual(["top-agent"]);
    expect(ids(resolveInstructions(PORTAL, "threads", "cursor", DOCS))).toContain("nw-cursor");
    expect(ids(resolveInstructions(PORTAL, "threads", "codex", DOCS))).not.toContain("nw-cursor");
  });
});
