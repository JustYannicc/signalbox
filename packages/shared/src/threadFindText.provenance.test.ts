import { expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  searchableMessageDocument,
  searchableMessageSegments,
  searchablePlanDocument,
  searchablePlanSegments,
  resolveThreadFindRange,
} from "@t3tools/shared/threadFindText";
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { relabelThreadLinks, relabelThreadLinksSourceMap } from "@t3tools/shared/threadLinks";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  upgradeLegacyContextMessage,
  upgradeLegacyContextMessageWithSourceMap,
} from "@t3tools/shared/composerContextLegacy";
import {
  stripDisplayedPlanMarkdown,
  stripDisplayedPlanWithSourceMap,
} from "@t3tools/shared/proposedPlanText";
import {
  renderCodexInlineDirectivesAsMarkdown,
  renderCodexInlineDirectivesWithSourceMap,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import {
  composeTextSourceMaps,
  sliceTextSourceMap,
  identityTextSourceMap,
  textRangeToSource,
} from "@t3tools/shared/textSourceMap";

const message = (text: string) => ({ role: "assistant" as const, text, streaming: false });

it("owns decoded tokens, normalized CRLF and UTF16 casefold intervals", () => {
  const text = "A &amp; \\* 😀\r\nΣς İ";
  const doc = searchableMessageDocument(message(text))!;
  expect(doc.segments.map((segment) => segment.text)).toEqual(
    searchableMessageSegments(message(text)),
  );
  const segment = doc.segments[0]!;
  for (const [query, authored] of [
    ["&", "&amp;"],
    ["*", "\\*"],
    ["😀", "😀"],
    [" ", " "],
    ["σσ", "Σς"],
    ["İ", "İ"],
  ]) {
    const start = findThreadSearchOccurrences(segment.text, query!)[0]!;
    const selected = resolveThreadFindRange(doc, 0, { start, end: start + query!.length });
    expect(selected?.ranges.map((range) => text.slice(range.start, range.end)).join("")).toBe(
      authored,
    );
  }
  const newline = segment.text.indexOf(" Σ");
  expect(resolveThreadFindRange(doc, 0, { start: newline, end: newline + 1 })?.ranges).toEqual([
    { start: text.indexOf("\r"), end: text.indexOf("\r") + 2 },
  ]);
});

it("keeps repeated visible text after omitted context tied to its own original source", () => {
  const review =
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">needle\n```diff\n+ needle\n```\n</review_comment>';
  const text = `needle\n${review}\nneedle`;
  const input = { role: "user" as const, text, streaming: false };
  const upgraded = upgradeLegacyContextMessageWithSourceMap(text);
  expect({ text: upgraded.text, records: upgraded.records }).toEqual(
    upgradeLegacyContextMessage(text),
  );
  const doc = searchableMessageDocument(input)!;
  expect(doc.source).toBe(text);
  expect(doc.segments.map((segment) => segment.text)).toEqual(searchableMessageSegments(input));
  const last = doc.segments.at(-1)!;
  const start = last.text.indexOf("needle");
  expect(
    resolveThreadFindRange(doc, doc.segments.length - 1, { start, end: start + 6 })?.ranges,
  ).toEqual([{ start: text.lastIndexOf("needle"), end: text.length }]);
});

it("uses one anchored slot for the entire custom file label and disambiguation suffix", () => {
  const text = "[**same**](/repo/src/main.ts) [same](/repo/tests/main.ts)";
  const doc = searchableMessageDocument(message(text))!;
  const runs = doc.segments[0]!.runs.filter((run) => run.target.kind === "slot");
  expect(runs).toHaveLength(2);
  expect(runs[0]!.target).toMatchObject({
    kind: "slot",
    slot: { kind: "link-label", text: "same main.ts · repo/src", sourceStart: 3, sourceEnd: 7 },
  });
  expect(runs[1]!.target).toMatchObject({
    kind: "slot",
    slot: {
      text: "same main.ts · repo/tests",
      sourceStart: text.lastIndexOf("same"),
      sourceEnd: text.lastIndexOf("same") + 4,
    },
  });
});

it("indexes citation and skill labels as distinct source-owned display slots", () => {
  const citation = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "hidden quote",
    comment: "shown note",
    start: 0,
    end: 12,
    prefix: "",
    suffix: "",
  });
  const text = `Use $test now ${citation}`;
  const doc = searchableMessageDocument(message(text), undefined, [
    { name: "test", displayName: "Testing" },
  ])!;
  expect(doc.segments[0]!.text).toBe("Use Testing now shown note");
  const slots = doc.segments[0]!.runs.flatMap((run) =>
    run.target.kind === "slot" ? [run.target.slot] : [],
  );
  expect(slots.map((slot) => text.slice(slot.sourceStart, slot.sourceEnd))).toEqual([
    "$test",
    "Assistant quote",
  ]);
  expect(slots.map((slot) => slot.text)).toEqual(["Testing", "shown note"]);
});

it("normalizes skill-label LF and CRLF in both public strings and display slots", () => {
  const source = "Use $check now";
  for (const [displayName, expected] of [
    ["Needle\nTwo", "Needle Two"],
    ["Needle\r\nTwo", "Needle Two"],
    ["foo\nbar", "foo bar"],
    ["foo\r\nbar", "foo bar"],
    ["foo\rbar", "foo\rbar"],
  ] as const) {
    const skills = [{ name: "check", displayName }];
    for (const role of ["assistant", "user"] as const) {
      const input = { role, text: source, streaming: false };
      const doc = searchableMessageDocument(input, undefined, skills)!;
      expect(searchableMessageSegments(input, undefined, skills)).toEqual([`Use ${expected} now`]);
      expect(doc.segments[0]!.text).toBe(`Use ${expected} now`);
      expect(resolveThreadFindRange(doc, 0, { start: 4, end: 4 + expected.length })).toEqual({
        ranges: [],
        slots: [
          {
            slot: { kind: "link-label", sourceStart: 4, sourceEnd: 10, text: expected },
            start: 0,
            end: expected.length,
          },
        ],
      });
    }
  }
});

it("maps parser-removed prose continuation indentation independently of the opening column", () => {
  for (const fixture of [
    "alpha\n beta",
    "alpha\n   beta",
    "alpha\n        beta",
    "alpha\n \tbeta",
    "[alpha\n   beta](https://example.com)",
    "> alpha\n>   beta",
    "> > alpha\n> > \t beta",
    "- alpha\n        beta",
    "> - alpha\n>     beta",
    "- > alpha\n  >    beta",
  ]) {
    for (const ending of ["\n", "\r\n"]) {
      const source = fixture.replaceAll("\n", ending);
      const doc = searchableMessageDocument(message(source))!;
      expect(searchableMessageSegments(message(source))).toEqual(["alpha beta"]);
      expect(doc.segments[0]!.text).toBe("alpha beta");
      for (const [query, start] of [
        ["alpha", 0],
        ["beta", 6],
      ] as const) {
        expect(
          resolveThreadFindRange(doc, 0, { start, end: start + query.length })?.ranges,
        ).toEqual([{ start: source.indexOf(query), end: source.indexOf(query) + query.length }]);
      }
      const phrase = resolveThreadFindRange(doc, 0, { start: 0, end: 10 });
      expect(phrase?.ranges.map((range) => source.slice(range.start, range.end)).join("")).toBe(
        `alpha${ending}beta`,
      );
    }
  }
});

it("retains significant continuation padding inside inline and fenced code", () => {
  for (const [source, expected] of [
    ["`alpha\n   beta`", "alpha    beta"],
    ["`alpha\n\tbeta`", "alpha \tbeta"],
    ["```text\n  alpha\n   beta\n```", "  alpha\n   beta\n"],
    ["```text\n> alpha\n  beta\n```", "> alpha\n  beta\n"],
  ] as const) {
    const doc = searchableMessageDocument(message(source))!;
    expect(searchableMessageSegments(message(source))).toEqual([expected]);
    expect(doc.segments[0]!.text).toBe(expected);
    const start = expected.indexOf("beta");
    expect(resolveThreadFindRange(doc, 0, { start, end: start + 4 })?.ranges).toEqual([
      { start: source.indexOf("beta"), end: source.indexOf("beta") + 4 },
    ]);
  }
});

it("uses the same thread-id precedence for ordinary and mapped live titles", () => {
  const source =
    "[a](t3-thread://v1/a%3A1) [b](t3-thread://v1/b%3A1) [c](t3-thread://v1/c%3A1) [blank](t3-thread://v1/empty%3A1) `[literal](t3-thread://v1/a%3A1)`";
  const titles = new Map([
    ["a%3A1", "Literal"],
    ["a:1", "Unused"],
    ["b:1", "Decoded"],
    ["c%3A1", ""],
    ["c:1", "Unused"],
    ["empty%3A1", " \t"],
    ["empty:1", "Unused"],
  ]);
  const expected =
    "[Literal](t3-thread://v1/a%3A1) [Decoded](t3-thread://v1/b:1) [c](t3-thread://v1/c%3A1) [blank](t3-thread://v1/empty%3A1) `[literal](t3-thread://v1/a%3A1)`";
  const map = relabelThreadLinksSourceMap(source, (id) => titles.get(id));
  expect(relabelThreadLinks(source, (id) => titles.get(id))).toBe(expected);
  expect(map.text).toBe(expected);
  expect(textRangeToSource(map, { start: 1, end: 8 })).toEqual([{ start: 0, end: 25 }]);
});

it("shares the exact displayed-plan body boundary across string and mapped output", () => {
  for (const [fixture, expected] of [
    ["# Title\n\n## Summary\n\nBody\n", "Body"],
    ["# Title\n\n## Scope\n\nBody\n", "## Scope\n\nBody"],
    ["\n# Title\nBody\n", "# Title\nBody"],
    ["\n## sUmMaRy\n\nBody \t\n", "Body"],
    ["# Title\n## Summary\n\n## Summary\nBody", "## Summary\nBody"],
    ["# Title", ""],
    ["   \n\n", ""],
    ["Body\n\nlast\n", "Body\n\nlast"],
  ] as const) {
    for (const ending of ["\n", "\r\n"]) {
      const source = fixture.replaceAll("\n", ending);
      const map = stripDisplayedPlanWithSourceMap(source);
      expect(stripDisplayedPlanMarkdown(source)).toBe(expected);
      expect(map.text).toBe(expected);
      if (expected.includes("Body")) {
        const start = expected.indexOf("Body");
        expect(textRangeToSource(map, { start, end: start + 4 })).toEqual([
          { start: source.indexOf("Body"), end: source.indexOf("Body") + 4 },
        ]);
      }
    }
  }
});

it("maps plan body through heading stripping and CRLF normalization without changing strings", () => {
  for (const source of [
    "# Title\r\n\r\n## Summary\r\n\r\nneedle 😀\r\n",
    "\n# Title\nBody",
    "# Title",
    "",
    "## Summary\r\nBody",
  ]) {
    const map = stripDisplayedPlanWithSourceMap(source);
    expect(map.text).toBe(stripDisplayedPlanMarkdown(source));
    const doc = searchablePlanDocument(source);
    expect(doc.source).toBe(source);
    expect(doc.segments.map((segment) => segment.text)).toEqual(searchablePlanSegments(source));
    const body = doc.segments[1];
    if (body?.text.includes("needle"))
      expect(resolveThreadFindRange(doc, 1, { start: 0, end: 6 })?.ranges).toEqual([
        { start: source.indexOf("needle"), end: source.indexOf("needle") + 6 },
      ]);
  }
});

it("composes artifact splitting and directive expansion by exact source ownership", () => {
  const source =
    'before\n\n::artifact-template{artifact_kind="document" display_name="Template" skill_directory="/tmp/skill" skill_name="writer"}\n\nafter :codex-file-citation{path="/tmp/main.ts"}';
  for (const part of splitCodexArtifactTemplateMarkdown(source)) {
    if (part.kind !== "markdown") continue;
    const slice = sliceTextSourceMap(identityTextSourceMap(source), {
      start: part.sourceOffset,
      end: part.sourceOffset + part.markdown.length,
    });
    const directives = renderCodexInlineDirectivesWithSourceMap(part.markdown);
    expect(directives.text).toBe(renderCodexInlineDirectivesAsMarkdown(part.markdown));
    const map = composeTextSourceMaps(slice, directives);
    const generated = map.spans.find((span) => span.kind === "replace");
    if (generated)
      expect(textRangeToSource(map, { start: generated.start, end: generated.end })).toEqual([
        { start: source.indexOf(":codex-file-citation"), end: source.length },
      ]);
  }
});

it("rejects gaps, stale copied text and out-of-range intervals", () => {
  const doc = searchableMessageDocument(message("needle"))!;
  expect(
    resolveThreadFindRange({ ...doc, segments: [{ text: "needle", runs: [] }] }, 0, {
      start: 0,
      end: 6,
    }),
  ).toBeNull();
  expect(resolveThreadFindRange({ ...doc, source: "staler" }, 0, { start: 0, end: 6 })).toBeNull();
  expect(resolveThreadFindRange(doc, 0, { start: -1, end: 6 })).toBeNull();
  expect(resolveThreadFindRange(doc, 0, { start: 0, end: 7 })).toBeNull();
  expect(
    resolveThreadFindRange(searchableMessageDocument(message("😀"))!, 0, { start: 0, end: 1 }),
  ).toBeNull();
});

it("retains the source after a transformed GitHub alert marker", () => {
  const source = "> [!NOTE]\r\n> needle";
  const doc = searchableMessageDocument(message(source))!;
  expect(doc.segments[0]!.text).toBe("needle");
  expect(resolveThreadFindRange(doc, 0, { start: 0, end: 6 })?.ranges).toEqual([
    { start: source.indexOf("needle"), end: source.length },
  ]);
});

it("retains internal CRLF in fenced code and maps across its lines", () => {
  const source = "> > first\r\n> > second 😀\r\n\r\n```txt\r\nthird\r\nfourth\r\n```";
  const doc = searchableMessageDocument(message(source))!;
  expect(doc.segments.map((segment) => segment.text)).toEqual(
    searchableMessageSegments(message(source)),
  );
  expect(doc.segments[1]!.text).toBe("third\r\nfourth\n");
  expect(resolveThreadFindRange(doc, 1, { start: 0, end: 13 })?.ranges).toEqual([
    { start: source.indexOf("third"), end: source.indexOf("fourth") + 6 },
  ]);
});
