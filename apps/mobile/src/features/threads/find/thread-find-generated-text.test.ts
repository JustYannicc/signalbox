import { expect, it } from "vite-plus/test";
import {
  searchableMessageDocument,
  searchablePlanDocument,
  type ThreadFindDisplaySlot,
} from "@t3tools/shared/threadFindText";
import { createThreadFindMatchEvidence } from "@t3tools/shared/threadFindMatchEvidence";

import {
  threadFindGeneratedMarkdown,
  threadFindGeneratedSelection,
} from "./thread-find-generated-text";

const revision = "view:1";
const artifact =
  '::artifact-template{skill_name="artifact-template-test" skill_directory="/tmp/test" display_name="needle card" artifact_kind="document"}';
const message = (text: string) =>
  searchableMessageDocument({ role: "assistant", text, streaming: false })!;

it("encodes markup literally and maps only Unicode scalar boundaries", () => {
  const rendered = threadFindGeneratedMarkdown("*😀&");
  expect(rendered.markdown).toBe("&#42;&#128512;&#38;");
  expect([...rendered.boundaries]).toEqual([
    [0, 0],
    [1, 5],
    [3, 14],
    [4, 19],
  ]);
});

it("selects only the source-owned artifact among repeated equal labels", () => {
  const source = `${artifact}\n\n${artifact}`;
  const document = message(source);
  const first: ThreadFindDisplaySlot = {
    kind: "artifact-name",
    sourceStart: 0,
    sourceEnd: artifact.length,
    text: "needle card",
  };
  const second = { ...first, sourceStart: artifact.length + 2, sourceEnd: source.length };
  const request = {
    query: "needle",
    occurrence: 1,
    requestId: "find:2",
    revision,
    evidence: createThreadFindMatchEvidence(document, "needle", 1)!,
  };
  expect(threadFindGeneratedSelection({ document, slot: first, request, revision })).toBeNull();
  const selection = threadFindGeneratedSelection({ document, slot: second, request, revision });
  expect(selection?.ranges).toEqual([{ start: 0, end: 36 }]);
  expect(selection?.sourceMarkdown.slice(0, 36)).toBe(
    threadFindGeneratedMarkdown("needle").markdown,
  );
});

it("keeps plan title and body occurrences separate after CRLF stripping", () => {
  const source = "# needle 😀\r\n\r\n## Summary\r\n\r\nneedle body";
  const document = searchablePlanDocument(source);
  const slot: ThreadFindDisplaySlot = {
    kind: "plan-title",
    sourceStart: 0,
    sourceEnd: source.length,
    text: "needle 😀",
  };
  const request = {
    query: "needle",
    occurrence: 0,
    requestId: "find:plan",
    revision,
    evidence: createThreadFindMatchEvidence(document, "needle", 0)!,
  };
  expect(threadFindGeneratedSelection({ document, slot, request, revision })?.ranges).toEqual([
    { start: 0, end: 36 },
  ]);
  expect(
    threadFindGeneratedSelection({
      document,
      slot,
      request: {
        ...request,
        occurrence: 1,
        evidence: createThreadFindMatchEvidence(document, "needle", 1)!,
      },
      revision,
    }),
  ).toBeNull();
});

it("rejects stale evidence, edited labels, revisions, and requests cleared by closing Find", () => {
  const source = "# needle";
  const document = searchablePlanDocument(source);
  const slot: ThreadFindDisplaySlot = {
    kind: "plan-title",
    sourceStart: 0,
    sourceEnd: source.length,
    text: "needle",
  };
  const request = {
    query: "needle",
    occurrence: 0,
    requestId: "find:old",
    revision,
    evidence: createThreadFindMatchEvidence(document, "needle", 0)!,
  };
  expect(threadFindGeneratedSelection({ document, slot, request, revision: "view:2" })).toBeNull();
  expect(
    threadFindGeneratedSelection({
      document,
      slot: { ...slot, text: "other!" },
      request,
      revision,
    }),
  ).toBeNull();
  expect(
    threadFindGeneratedSelection({
      document: searchablePlanDocument("# other!"),
      slot,
      request,
      revision,
    }),
  ).toBeNull();
  expect(threadFindGeneratedSelection({ document, slot, request: null, revision })).toBeNull();
});
