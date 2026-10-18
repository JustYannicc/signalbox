// signalbox: keep the shared search corpus stable while adding source-owned selections.
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import type { InlineSkill } from "./inlineSkills.ts";
import { markdownThreadFindDocument } from "./threadFindMarkdown.ts";
import { identityTextSourceMap } from "./textSourceMap.ts";
import { remapThreadFindDocument, type ThreadFindDocument } from "./threadFindProvenance.ts";
import {
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
  stripDisplayedPlanWithSourceMap,
} from "./proposedPlanText.ts";
import {
  upgradeLegacyContextMessage,
  upgradeLegacyContextMessageWithSourceMap,
} from "./composerContextLegacy.ts";
import { shouldPreserveAssistantLineBreaks } from "./markdownPipeline.ts";
export { THREAD_FIND_BLOCK_TAGS } from "./threadFindMarkdown.ts";
export { threadFindNodeLabelAnchor, type ThreadFindTextTree } from "./markdownTextSourceMap.ts";
export {
  resolveThreadFindRange,
  resolveThreadFindRenderedRange,
  threadFindRenderedLabels,
} from "./threadFindProvenance.ts";
export type {
  ThreadFindDocument,
  ThreadFindSegment,
  ThreadFindProvenanceRun,
  ThreadFindDisplaySlot,
} from "./threadFindProvenance.ts";

/** Plans render `$skill` tokens literally (no skill chips), so they are indexed as written. */
export function searchablePlanSegments(markdown: string, cwd?: string): readonly string[] {
  return [
    proposedPlanTitle(markdown) ?? "Proposed plan",
    ...markdownThreadFindDocument(
      stripDisplayedPlanMarkdown(markdown),
      false,
      cwd,
      [],
    ).segments.map((segment) => segment.text),
  ];
}

export function searchableMessageSegments(
  message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "context">,
  cwd?: string,
  skills: readonly InlineSkill[] = [],
): readonly string[] | null {
  if (message.role === "user") {
    const text = message.context ? message.text : upgradeLegacyContextMessage(message.text).text;
    return markdownThreadFindDocument(text, true, cwd, skills).segments.map(
      (segment) => segment.text,
    );
  }
  if (message.role !== "assistant") return null;
  return markdownThreadFindDocument(
    message.text || (message.streaming ? "" : "(empty response)"),
    false,
    cwd,
    skills,
    shouldPreserveAssistantLineBreaks(message.text),
  ).segments.map((segment) => segment.text);
}

export function searchableMessageDocument(
  message: Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming" | "context">,
  cwd?: string,
  skills: readonly InlineSkill[] = [],
): ThreadFindDocument | null {
  if (message.role === "user") {
    const map = message.context
      ? identityTextSourceMap(message.text)
      : upgradeLegacyContextMessageWithSourceMap(message.text).sourceMap;
    return remapThreadFindDocument(
      markdownThreadFindDocument(map.text, true, cwd, skills, false, true),
      map,
    );
  }
  if (message.role !== "assistant") return null;
  if (!message.text && !message.streaming)
    return {
      source: message.text,
      segments: [
        {
          text: "(empty response)",
          runs: [
            {
              start: 0,
              end: 16,
              target: {
                kind: "slot",
                slot: {
                  kind: "empty-response",
                  sourceStart: 0,
                  sourceEnd: 0,
                  text: "(empty response)",
                },
                start: 0,
                end: 16,
              },
            },
          ],
        },
      ],
    };
  return markdownThreadFindDocument(
    message.text,
    false,
    cwd,
    skills,
    shouldPreserveAssistantLineBreaks(message.text),
    true,
  );
}

export function searchablePlanDocument(markdown: string, cwd?: string): ThreadFindDocument {
  const map = stripDisplayedPlanWithSourceMap(markdown);
  const body = remapThreadFindDocument(
    markdownThreadFindDocument(map.text, false, cwd, [], false, true),
    map,
  );
  const title = proposedPlanTitle(markdown) ?? "Proposed plan";
  return {
    source: markdown,
    segments: [
      {
        text: title,
        runs: [
          {
            start: 0,
            end: title.length,
            target: {
              kind: "slot",
              slot: { kind: "plan-title", sourceStart: 0, sourceEnd: markdown.length, text: title },
              start: 0,
              end: title.length,
            },
          },
        ],
      },
      ...body.segments,
    ],
  };
}
