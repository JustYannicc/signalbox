/** Layout primitives for the node details panel. */
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b px-4 py-4 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

export function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 text-sm text-foreground">{props.children}</dd>
    </div>
  );
}

export function CodeBlock(props: { children: string; tone?: "default" | "error" }) {
  return (
    <pre
      className={cn(
        "max-h-56 overflow-auto rounded-md px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
        props.tone === "error"
          ? "bg-destructive/8 text-destructive-foreground"
          : "bg-muted text-foreground",
      )}
    >
      {props.children}
    </pre>
  );
}

export function Prose(props: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-muted px-2.5 py-2 text-sm leading-relaxed">{props.children}</p>
  );
}

export function Note(props: { children: ReactNode }) {
  return (
    <p className="text-xs leading-relaxed text-pretty text-muted-foreground">{props.children}</p>
  );
}

export const Mono = (props: { children: ReactNode }) => (
  <code className="font-mono text-xs">{props.children}</code>
);
