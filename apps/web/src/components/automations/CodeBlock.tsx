import type { ReactNode } from "react";

/** A step's input, result, error or log, in mono, scrolling past a few lines. */
export function CodeBlock(props: { children: ReactNode; tone?: "error" }) {
  return (
    <pre
      className={
        props.tone === "error"
          ? "max-h-48 overflow-auto rounded-md bg-destructive/8 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-destructive-foreground"
          : "max-h-48 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-foreground"
      }
    >
      {props.children}
    </pre>
  );
}
