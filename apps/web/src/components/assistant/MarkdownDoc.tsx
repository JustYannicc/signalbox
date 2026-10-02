/** Plain monospace views of an instructions file (SOUL.md, AGENTS.md, USER.md). */

const DOC_CLASS =
  "h-80 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground";

export function MarkdownEditor(props: {
  label: string;
  note: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{props.note}</p>
      <textarea
        aria-label={props.label}
        value={props.value}
        spellCheck={false}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        className={`${DOC_CLASS} resize-none outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24`}
      />
    </div>
  );
}

export function MarkdownViewer(props: { label: string; value: string }) {
  return (
    <pre aria-label={props.label} className={`${DOC_CLASS} overflow-auto whitespace-pre-wrap`}>
      {props.value}
    </pre>
  );
}
