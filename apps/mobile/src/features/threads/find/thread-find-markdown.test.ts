import { expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { upgradeLegacyContextMessageWithSourceMap } from "@t3tools/shared/composerContextLegacy";
import {
  renderCodexInlineDirectivesWithSourceMap,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { searchableMessageDocument, searchablePlanDocument } from "@t3tools/shared/threadFindText";
import { createThreadFindMatchEvidence } from "@t3tools/shared/threadFindMatchEvidence";
import { stripDisplayedPlanWithSourceMap } from "@t3tools/shared/proposedPlanText";
import {
  applyTextSourceEdits,
  composeTextSourceMaps,
  identityTextSourceMap,
  sliceTextSourceMap,
} from "@t3tools/shared/textSourceMap";
import {
  createThreadFindMarkdownManifest,
  prepareThreadFindMarkdown,
  type ThreadFindMarkdownRequest,
} from "./thread-find-markdown";

const request = (query: string, occurrence = 0): ThreadFindMarkdownRequest => ({
  query,
  occurrence,
  requestId: "find-1",
  revision: "7",
});
const message = (text: string) => ({ role: "assistant" as const, text, streaming: false });
function manifest(text: string, query: string, occurrence = 0) {
  return createThreadFindMarkdownManifest({
    document: searchableMessageDocument(message(text)),
    sourceMap: prepareThreadFindMarkdown(identityTextSourceMap(text)),
    revision: "7",
    request: request(query, occurrence),
  });
}
function selectedSource(result: ReturnType<typeof manifest>) {
  return result?.sourceSelection?.ranges.map((range) =>
    result.markdown.slice(range.start, range.end),
  );
}

it("maps styled phrases, entities, escapes and emoji without selecting surrounding syntax", () => {
  const text = "A **bold** and *italic* &amp; \\* 😀.";
  expect(selectedSource(manifest(text, "bold and italic & * 😀"))).toEqual([
    "bold",
    " and ",
    "italic",
    " &amp; \\* 😀",
  ]);
  expect(selectedSource(manifest("&NotEqualTilde; &#x1F600;", "😀"))).toEqual(["&#x1F600;"]);
});

it("keeps full CRLF source ranges and nested quote offsets", () => {
  const text = "> > first\r\n> > second 😀\r\n\r\n```txt\r\nthird\r\nfourth\r\n```";
  expect(selectedSource(manifest(text, "first second 😀"))?.join("")).toBe("first\r\nsecond 😀");
  expect(selectedSource(manifest(text, "third\r\nfourth"))?.join("")).toBe("third\r\nfourth");
});

it("uses threadSearch case folding and nonoverlapping occurrence order", () => {
  expect(manifest("İ ΟΣ ος οσ", "Σ", 1)?.sourceSelection?.ranges).toEqual([{ start: 6, end: 7 }]);
  expect(manifest("aaaa", "aa", 1)?.sourceSelection?.ranges).toEqual([{ start: 2, end: 4 }]);
  expect(manifest("İ needle", "needle")?.sourceSelection?.ranges).toEqual([{ start: 2, end: 8 }]);
});

it("composes HTML conversion and inserted table breaks into exact final markdown", () => {
  const text =
    "<details><summary>Title &amp; 😀</summary><p>body</p></details>\n\n> Intro\n> | a | b |\n> | - | - |\n> | target | tail |";
  const html = manifest(text, "Title & 😀");
  expect(html?.markdown).not.toContain("<summary>");
  expect(selectedSource(html)?.join("")).toBe("Title &amp; 😀");
  const table = manifest(text, "target");
  expect(table?.markdown).toContain("> Intro\n>\n> | a | b |");
  expect(selectedSource(table)).toEqual(["target"]);
  expect(table?.sourceSelection?.ranges[0]?.start).toBe(table?.markdown.indexOf("target"));
});

it("anchors one custom file label including the basename and preserves repeated URL labels", () => {
  const text = "[**first**](/tmp/main.ts) then [second](/tmp/main.ts)";
  const result = manifest(text, "second main.ts");
  expect(result?.sourceLinkPillContent).toEqual([
    {
      sourceStart: text.indexOf("first"),
      sourceEnd: text.indexOf("first") + 5,
      label: "first main.ts",
    },
    {
      sourceStart: text.indexOf("second"),
      sourceEnd: text.indexOf("second") + 6,
      label: "second main.ts",
    },
  ]);
  expect(result?.sourceSelection?.labels).toEqual([
    {
      kind: "link-label",
      sourceStart: text.indexOf("second"),
      sourceEnd: text.indexOf("second") + 6,
      text: "second main.ts",
      start: 0,
      end: 14,
    },
  ]);
  expect(manifest(text, "main.ts", 0)?.sourceSelection?.labels?.[0]?.sourceStart).toBe(
    text.indexOf("first"),
  );
});

it("anchors internal formatting between the first and last owned label runs", () => {
  const text = "[**a** *b*](/tmp/x.ts)";
  expect(manifest(text, "a b x.ts")?.sourceLinkPillContent).toEqual([
    { sourceStart: text.indexOf("a"), sourceEnd: text.indexOf("b") + 1, label: "a b x.ts" },
  ]);
});

it("uses exact recognized skill tokens and code content without backticks", () => {
  const text =
    "Use $alpha $alpha-long now\n\n`/tmp/code.ts:42`\n\n```txt\n$alpha /tmp/code.ts:42\n```";
  const skills = [
    { name: "alpha", displayName: "Same Skill" },
    { name: "alpha-long", displayName: "Same Skill" },
  ];
  const result = createThreadFindMarkdownManifest({
    document: searchableMessageDocument(message(text), undefined, skills),
    sourceMap: identityTextSourceMap(text),
    revision: "7",
    request: request("Same Skill", 1),
    skills,
  });
  expect(result?.sourceLinkPillContent).toEqual([
    {
      sourceStart: text.indexOf("$alpha"),
      sourceEnd: text.indexOf("$alpha") + 6,
      label: "Same Skill",
    },
    {
      sourceStart: text.indexOf("$alpha-long"),
      sourceEnd: text.indexOf("$alpha-long") + 11,
      label: "Same Skill",
    },
    {
      sourceStart: text.indexOf("/tmp/code.ts:42"),
      sourceEnd: text.indexOf("/tmp/code.ts:42") + 15,
      label: "code.ts · L42",
    },
  ]);
  expect(result?.sourceSelection?.labels?.[0]?.sourceStart).toBe(text.indexOf("$alpha-long"));
  expect(selectedSource(manifest(text, "$alpha"))).toEqual(["$alpha"]);
});

it("requires server and renderer skill labels to agree even for matches outside a skill", () => {
  const text = "Use $alpha now needle";
  const skills = [{ name: "alpha", displayName: "Alpha Skill" }];
  const serverDocument = searchableMessageDocument(message(text), undefined, skills)!;
  const evidence = createThreadFindMatchEvidence(serverDocument, "needle", 0);
  const result = (rendererSkills: typeof skills) =>
    createThreadFindMarkdownManifest({
      document: searchableMessageDocument(message(text), undefined, rendererSkills),
      sourceMap: identityTextSourceMap(text),
      revision: "7",
      request: { ...request("needle"), evidence },
      skills: rendererSkills,
    });

  expect(selectedSource(result(skills))).toEqual(["needle"]);
  expect(result([])?.sourceSelection).toBeNull();
  expect(result([{ name: "alpha", displayName: "Other Skill" }])?.sourceSelection).toBeNull();
});

it("maps atomic directives to their exact parsed label rather than the URL or full replacement", () => {
  const directive = ':codex-file-citation{path="/tmp/report.xlsx" purpose="output"}';
  const text = `${directive} and ${directive}`;
  const sourceMap = prepareThreadFindMarkdown(renderCodexInlineDirectivesWithSourceMap(text));
  const result = createThreadFindMarkdownManifest({
    document: searchableMessageDocument(message(text)),
    sourceMap,
    revision: "7",
    request: request("report.xlsx", 1),
  });
  expect(result?.sourceLinkPillContent).toHaveLength(2);
  const label = result?.sourceSelection?.labels?.[0];
  expect(label && sourceMap.text.slice(label.sourceStart, label.sourceEnd)).toBe("report.xlsx");
  expect(label?.sourceStart).toBe(sourceMap.text.lastIndexOf("[report.xlsx]") + 1);
});

it("retains raw citation syntax while overriding the semantic citation label", () => {
  const citation = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("e"),
    threadId: ThreadId.make("t"),
    messageId: MessageId.make("m"),
    text: "cited needle",
    start: 0,
    end: 12,
    prefix: "",
    suffix: "",
  });
  const result = manifest(citation, "needle");
  expect(result?.markdown).toBe(citation);
  expect(result?.sourceLinkPillContent).toEqual([
    { sourceStart: 1, sourceEnd: 16, label: "cited needle" },
  ]);
  expect(result?.sourceSelection?.labels?.[0]).toMatchObject({
    text: "cited needle",
    start: 6,
    end: 12,
  });
});

it("keeps artifact occurrence slots explicit and does not renumber surrounding renderer slices", () => {
  const artifact =
    '::artifact-template{skill_name="artifact-template-test" skill_directory="/tmp/test" display_name="needle card" artifact_kind="document"}';
  const text = `needle before\n\n${artifact}\n\nneedle after`;
  const document = searchableMessageDocument(message(text));
  const segments = splitCodexArtifactTemplateMarkdown(text);
  const after = segments.at(-1)!;
  expect(after.kind).toBe("markdown");
  const map = sliceTextSourceMap(identityTextSourceMap(text), {
    start: after.sourceOffset,
    end: text.length,
  });
  const result = (occurrence: number) =>
    createThreadFindMarkdownManifest({
      document,
      sourceMap: map,
      revision: "7",
      request: request("needle", occurrence),
    });
  expect(result(0)?.sourceSelection).toBeNull();
  expect(result(1)?.selectedGeneratedSlot).toMatchObject({
    slot: {
      kind: "artifact-name",
      sourceStart: text.indexOf(artifact),
      sourceEnd: text.indexOf(artifact) + artifact.length,
      text: "needle card",
    },
    start: 0,
    end: 6,
  });
  expect(result(1)?.sourceSelection).toBeNull();
  expect(selectedSource(result(2))).toEqual(["needle"]);
});

it("excludes context and review labels before counting visible occurrences", () => {
  const text =
    'needle[needle hidden](t3-context://v1/terminal/a) needle\n\n<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">\nneedle hidden\n</review_comment>\n\nneedle end';
  const sourceMap = prepareThreadFindMarkdown(
    upgradeLegacyContextMessageWithSourceMap(text).sourceMap,
  );
  const document = searchableMessageDocument({ role: "user", text, streaming: false });
  const result = createThreadFindMarkdownManifest({
    document,
    sourceMap,
    revision: "7",
    request: request("needle", 2),
  });
  expect(selectedSource(result)).toEqual(["needle"]);
  expect(result?.sourceSelection?.ranges[0]?.start).toBe(result?.markdown.lastIndexOf("needle"));
});

it("hands plan titles to their component and maps the stripped CRLF body", () => {
  const text = "# The needle\r\n\r\n## Summary\r\n\r\nbody needle\r\n";
  const document = searchablePlanDocument(text);
  const sourceMap = stripDisplayedPlanWithSourceMap(text);
  const title = createThreadFindMarkdownManifest({
    document,
    sourceMap,
    revision: "7",
    request: request("needle"),
  });
  expect(title?.selectedGeneratedSlot).toMatchObject({
    slot: { kind: "plan-title", text: "The needle" },
    start: 4,
    end: 10,
  });
  expect(title?.sourceSelection).toBeNull();
  expect(
    selectedSource(
      createThreadFindMarkdownManifest({
        document,
        sourceMap,
        revision: "7",
        request: request("needle", 1),
      }),
    ),
  ).toEqual(["needle"]);
});

it("rejects stale revisions, invalid occurrences, incomplete maps and partial renderer ownership", () => {
  const text = "a needle b";
  const document = searchableMessageDocument(message(text));
  const sourceMap = identityTextSourceMap(text);
  const run = (overrides: Partial<Parameters<typeof createThreadFindMarkdownManifest>[0]>) =>
    createThreadFindMarkdownManifest({
      document,
      sourceMap,
      revision: "7",
      request: request("needle"),
      ...overrides,
    });
  expect(run({ revision: "8" })?.sourceSelection).toBeNull();
  expect(run({ request: request("needle", 1) })?.sourceSelection).toBeNull();
  expect(run({ request: request("needle", -1) })?.sourceSelection).toBeNull();
  expect(run({ sourceMap: { ...sourceMap, spans: [] } })).toBeNull();
  expect(run({ sourceMap: identityTextSourceMap("a noodle b") })).toBeNull();
  expect(
    run({ sourceMap: sliceTextSourceMap(sourceMap, { start: 4, end: text.length }) })
      ?.sourceSelection,
  ).toBeNull();
  expect(manifest("😀", "\ud83d")?.sourceSelection).toBeNull();
});

it("does not project replaced prose onto live labels with the same length", () => {
  const text = "[old label](https://example.com)";
  const sourceMap = applyTextSourceEdits(text, [{ start: 1, end: 10, text: "new label" }]);
  expect(
    createThreadFindMarkdownManifest({
      document: searchableMessageDocument(message(text)),
      sourceMap,
      revision: "7",
      request: request("old label"),
    })?.sourceSelection,
  ).toBeNull();
});

it("rejects stale evidence even when source length, query and occurrence still match", () => {
  const text = "needle first";
  const original = searchableMessageDocument(message(text))!;
  const evidence = createThreadFindMatchEvidence(original, "needle", 0);
  expect(evidence).toBeDefined();
  const current = "needle other";
  const make = (document: typeof original, source: string) =>
    createThreadFindMarkdownManifest({
      document,
      sourceMap: identityTextSourceMap(source),
      revision: "7",
      request: { ...request("needle"), evidence },
    });
  expect(make(original, text)?.sourceSelection).not.toBeNull();
  expect(make(searchableMessageDocument(message(current))!, current)?.sourceSelection).toBeNull();
});

it("has no recency or arbitrary text length cap", () => {
  const text = `${"long ".repeat(20_000)}needle`;
  expect(manifest(text, "needle")?.sourceSelection?.ranges).toEqual([
    { start: text.length - 6, end: text.length },
  ]);
});

it("retains source ownership when a full original node becomes a differently labeled native link", () => {
  const text = "[custom](/tmp/file.ts)";
  const document = searchableMessageDocument(message(text))!;
  const slot = {
    kind: "link-label" as const,
    sourceStart: 0,
    sourceEnd: text.length,
    text: "custom file.ts",
  };
  const anchored = {
    ...document,
    segments: [
      {
        text: slot.text,
        runs: [
          {
            start: 0,
            end: slot.text.length,
            target: { kind: "slot" as const, slot, start: 0, end: slot.text.length },
          },
        ],
      },
    ],
  };
  const sourceMap = composeTextSourceMaps(
    identityTextSourceMap(text),
    applyTextSourceEdits(text, [{ start: 0, end: text.length, text: "[renamed](/tmp/file.ts)" }]),
  );
  const result = createThreadFindMarkdownManifest({
    document: anchored,
    sourceMap,
    revision: "7",
    request: request("file.ts"),
  });
  expect(result?.sourceLinkPillContent).toEqual([
    { sourceStart: 1, sourceEnd: 8, label: "custom file.ts" },
  ]);
  expect(result?.sourceSelection?.labels?.[0]).toMatchObject({
    sourceStart: 1,
    sourceEnd: 8,
    text: "custom file.ts",
    start: 7,
    end: 14,
  });
});

it("rejects ambiguous cloned ownership for prose and native label anchors", () => {
  const duplicate = (text: string) => ({
    source: text,
    text: `${text} ${text}`,
    spans: [
      { start: 0, end: text.length, sourceStart: 0, sourceEnd: text.length, kind: "copy" as const },
      {
        start: text.length,
        end: text.length + 1,
        sourceStart: 0,
        sourceEnd: 0,
        kind: "insert" as const,
      },
      {
        start: text.length + 1,
        end: text.length * 2 + 1,
        sourceStart: 0,
        sourceEnd: text.length,
        kind: "copy" as const,
      },
    ],
  });
  const plain = "needle";
  expect(
    createThreadFindMarkdownManifest({
      document: searchableMessageDocument(message(plain)),
      sourceMap: duplicate(plain),
      revision: "7",
      request: request("needle"),
    })?.sourceSelection,
  ).toBeNull();
  const link = "[label](/tmp/main.ts)";
  expect(
    createThreadFindMarkdownManifest({
      document: searchableMessageDocument(message(link)),
      sourceMap: duplicate(link),
      revision: "7",
      request: request("label"),
    }),
  ).toBeNull();
});

it("supplies the complete display label manifest without an active Find request", () => {
  const text = "[first](/tmp/same.ts) [second](/tmp/same.ts)";
  const result = createThreadFindMarkdownManifest({
    document: searchableMessageDocument(message(text)),
    sourceMap: identityTextSourceMap(text),
    revision: "7",
  });
  expect(result?.sourceLinkPillContent.map((entry) => entry.label)).toEqual([
    "first same.ts",
    "second same.ts",
  ]);
  expect(result?.sourceSelection).toBeNull();
});
