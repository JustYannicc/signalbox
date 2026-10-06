import {
  PERSONAL_CONTEXT_ID,
  SignalboxContextId,
  type SignalboxContextsSnapshot,
  SignalboxSectionId,
} from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "vite-plus/test";

import { buildContextTrees, sectionMoveFor, sectionNudgeFor } from "./signalboxContexts.ts";

const ACME = SignalboxContextId.make("org_acme");
const id = SignalboxSectionId.make;

const section = (
  sectionId: string,
  parentId: string | null = null,
  contextId = PERSONAL_CONTEXT_ID,
) => ({
  id: id(sectionId),
  contextId,
  parentId: parentId === null ? null : id(parentId),
  name: sectionId.toUpperCase(),
});

// Personal: a, b (b1, b2), c. Acme: x.
const snapshot: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL_CONTEXT_ID, kind: "personal", name: "Personal" },
    { id: ACME, kind: "organization", name: "Acme" },
  ],
  sections: [
    section("a"),
    section("b"),
    section("c"),
    section("b1", "b"),
    section("b2", "b"),
    section("x", null, ACME),
  ],
};

describe("buildContextTrees", () => {
  it("nests each context's sections in order", () => {
    const trees = buildContextTrees(snapshot);
    expect(trees.map((tree) => tree.context.name)).toEqual(["Personal", "Acme"]);
    expect(
      trees[0]?.sections.map((node) => [node.section.id, node.children.map((c) => c.section.id)]),
    ).toEqual([
      ["a", []],
      ["b", ["b1", "b2"]],
      ["c", []],
    ]);
    expect(trees[1]?.sections.map((node) => node.section.id)).toEqual(["x"]);
  });
});

describe("sectionMoveFor", () => {
  it("drops before, after or inside another section", () => {
    expect(sectionMoveFor(snapshot, id("c"), { kind: "before", targetId: id("a") })).toEqual({
      sectionId: "c",
      parentId: null,
      index: 0,
    });
    expect(sectionMoveFor(snapshot, id("a"), { kind: "after", targetId: id("b1") })).toEqual({
      sectionId: "a",
      parentId: "b",
      index: 1,
    });
    expect(sectionMoveFor(snapshot, id("c"), { kind: "inside", targetId: id("b") })).toEqual({
      sectionId: "c",
      parentId: "b",
      index: 2,
    });
    expect(
      sectionMoveFor(snapshot, id("b1"), { kind: "context-end", contextId: PERSONAL_CONTEXT_ID }),
    ).toEqual({
      sectionId: "b1",
      parentId: null,
      index: 3,
    });
  });

  it("refuses moves below itself, across contexts, or to where it already is", () => {
    expect(sectionMoveFor(snapshot, id("b"), { kind: "inside", targetId: id("b2") })).toBeNull();
    expect(sectionMoveFor(snapshot, id("b"), { kind: "inside", targetId: id("b") })).toBeNull();
    expect(sectionMoveFor(snapshot, id("a"), { kind: "inside", targetId: id("x") })).toBeNull();
    expect(sectionMoveFor(snapshot, id("a"), { kind: "context-end", contextId: ACME })).toBeNull();
    expect(sectionMoveFor(snapshot, id("a"), { kind: "before", targetId: id("b") })).toBeNull();
  });
});

describe("sectionNudgeFor", () => {
  it("moves past siblings, indents into the previous one and outdents after the parent", () => {
    expect(sectionNudgeFor(snapshot, id("b"), "up")).toEqual({
      sectionId: "b",
      parentId: null,
      index: 0,
    });
    expect(sectionNudgeFor(snapshot, id("b"), "down")).toEqual({
      sectionId: "b",
      parentId: null,
      index: 2,
    });
    expect(sectionNudgeFor(snapshot, id("c"), "indent")).toEqual({
      sectionId: "c",
      parentId: "b",
      index: 2,
    });
    expect(sectionNudgeFor(snapshot, id("b1"), "outdent")).toEqual({
      sectionId: "b1",
      parentId: null,
      index: 2,
    });
  });

  it("does nothing at the edges", () => {
    expect(sectionNudgeFor(snapshot, id("a"), "up")).toBeNull();
    expect(sectionNudgeFor(snapshot, id("c"), "down")).toBeNull();
    expect(sectionNudgeFor(snapshot, id("a"), "indent")).toBeNull();
    expect(sectionNudgeFor(snapshot, id("a"), "outdent")).toBeNull();
  });
});
