import { parseTaskOutcome } from "@t3tools/shared/taskOutcome";

import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

/**
 * Outcomes are one line of plain text that may carry inline `[label](url)` links, such as
 * a deploy run. Anything else, including older plain outcomes, renders verbatim; a link
 * with an unsafe scheme keeps only its label (see `parseTaskOutcome`).
 */
export function TaskOutcomeText(props: { readonly text: string; readonly className?: string }) {
  const parts = parseTaskOutcome(props.text);

  return (
    <Text className={props.className}>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <Text
            // Parts are positional for a given string and never reorder.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            accessibilityRole="link"
            accessibilityHint="Opens in your browser"
            className={`${props.className ?? ""} underline`}
            onPress={() => void tryOpenExternalUrl(part.url, "markdown-link")}
          >
            {part.label}
          </Text>
        ),
      )}
    </Text>
  );
}
