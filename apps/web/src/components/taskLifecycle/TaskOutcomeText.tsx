import { parseTaskOutcome } from "@t3tools/shared/taskOutcome";

/**
 * Outcomes are one line of plain text that may carry inline `[label](url)` links, such as
 * a deploy run. Anything else, including older plain outcomes, renders verbatim; a link
 * with an unsafe scheme keeps only its label (see `parseTaskOutcome`).
 */
export function TaskOutcomeText(props: { readonly text: string }) {
  const parts = parseTaskOutcome(props.text);

  return parts.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      // A plain anchor: the desktop window turns a blocked _blank into openExternal itself.
      <a
        // Parts are positional for a given string and never reorder.
        // oxlint-disable-next-line react/no-array-index-key
        key={index}
        href={part.url}
        target="_blank"
        rel="noreferrer noopener"
        className="underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        {part.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    ),
  );
}
