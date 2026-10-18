import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { upgradeLegacyContextMessageWithSourceMap } from "@t3tools/shared/composerContextLegacy";
import {
  composeTextSourceMaps,
  identityTextSourceMap,
  sliceTextSourceMap,
} from "@t3tools/shared/textSourceMap";

import type { ThreadFeedMessage } from "../../../lib/threadActivity";

/** Presentation can hide a legacy schedule prefix; its remaining body is an exact suffix. */
export function threadMessageSource(
  message: Pick<
    ThreadFeedMessage,
    "id" | "role" | "text" | "context" | "scheduledTaskId" | "createdBy" | "creationSource"
  >,
) {
  const presentation = resolveUserMessagePresentation(message);
  let sourceMap = sliceTextSourceMap(identityTextSourceMap(message.text), {
    start: message.text.length - presentation.text.length,
    end: message.text.length,
  });
  if (sourceMap.text !== presentation.text)
    throw new Error("Message presentation lost source ownership");
  let context = message.context;
  if (message.role === "user" && !context) {
    const legacy = upgradeLegacyContextMessageWithSourceMap(sourceMap.text);
    sourceMap = composeTextSourceMaps(sourceMap, legacy.sourceMap);
    if (legacy.records.length) context = { version: 1, records: legacy.records };
  }
  return { sourceMap, context };
}
