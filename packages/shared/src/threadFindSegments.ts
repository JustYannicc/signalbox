import { markdownTextSourceMap, type ThreadFindTextTree } from "./markdownTextSourceMap.ts";
import {
  matchInlineSkills,
  formatProviderSkillDisplayName,
  type InlineSkill,
} from "./inlineSkills.ts";
import {
  applyTextSourceEdits,
  composeTextSourceMaps,
  sliceTextSourceMap,
  textRangeToSource,
  type TextSourceMap,
  type TextRange,
} from "./textSourceMap.ts";
import type {
  ThreadFindSegment,
  ThreadFindProvenanceRun,
  ThreadFindDisplaySlot,
} from "./threadFindProvenance.ts";

export function createThreadFindSegments(markdown: string, provenance: boolean) {
  const segments: ThreadFindSegment[] = [];
  let text = "";
  let runs: ThreadFindProvenanceRun[] = [];
  const append = (value: string, map: TextSourceMap | null) => {
    if (!value) return;
    if (!provenance) {
      text += value;
      return;
    }
    if (!map || map.text !== value)
      runs.push({
        start: text.length,
        end: text.length + value.length,
        target: { kind: "unmapped" },
      });
    else
      for (const span of map.spans)
        runs.push({
          start: text.length + span.start,
          end: text.length + span.end,
          target:
            span.kind === "insert"
              ? { kind: "unmapped" }
              : {
                  kind: "source",
                  sourceStart: span.sourceStart,
                  sourceEnd: span.sourceEnd,
                  atomic: span.kind !== "copy",
                },
        });
    text += value;
  };
  const appendSlot = (
    value: string,
    kind: ThreadFindDisplaySlot["kind"],
    anchor: TextRange | null,
    href?: string,
  ) => {
    if (!value) return;
    if (!provenance) {
      text += value;
      return;
    }
    const slot: ThreadFindDisplaySlot | null = anchor
      ? {
          kind,
          sourceStart: anchor.start,
          sourceEnd: anchor.end,
          text: value,
          ...(href === undefined ? {} : { href }),
        }
      : null;
    runs.push({
      start: text.length,
      end: text.length + value.length,
      target: slot ? { kind: "slot", slot, start: 0, end: value.length } : { kind: "unmapped" },
    });
    text += value;
  };
  const flush = () => {
    if (text.trim()) segments.push({ text, runs });
    text = "";
    runs = [];
  };

  const appendText = (
    node: ThreadFindTextTree,
    inPre: boolean,
    inlineSkills: boolean,
    skills: readonly InlineSkill[],
    codeNode?: ThreadFindTextTree,
  ) => {
    const value = node.value ?? "";
    const leaf = codeNode ?? node;
    const map = provenance
      ? markdownTextSourceMap(
          markdown,
          leaf,
          value,
          codeNode ? (inPre ? "code" : "inlineCode") : node.type === "raw" ? "raw" : "text",
        )
      : null;
    const matches = inlineSkills ? matchInlineSkills(value, skills) : [];
    let cursor = 0;
    const appendSlice = (start: number, end: number) => {
      let part = map ? sliceTextSourceMap(map, { start, end }) : null;
      const raw = value.slice(start, end);
      if (!inPre && part)
        part = composeTextSourceMaps(
          part,
          applyTextSourceEdits(
            raw,
            [...raw.matchAll(/\r?\n/g)].map((match) => ({
              start: match.index,
              end: match.index + match[0].length,
              text: " ",
            })),
          ),
        );
      append(inPre ? raw : raw.replace(/\r?\n/g, " "), part);
    };
    for (const match of matches) {
      appendSlice(cursor, match.start);
      const anchorRanges = map
        ? textRangeToSource(map, { start: match.start, end: match.end })
        : null;
      const anchor = anchorRanges?.length
        ? { start: anchorRanges[0]!.start, end: anchorRanges.at(-1)!.end }
        : null;
      const label = formatProviderSkillDisplayName(match.skill);
      appendSlot(inPre ? label : label.replace(/\r?\n/g, " "), "link-label", anchor);
      cursor = match.end;
    }
    appendSlice(cursor, value.length);
  };
  return { segments, flush, appendSlot, appendText };
}
