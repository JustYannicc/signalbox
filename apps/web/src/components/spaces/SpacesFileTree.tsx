/**
 * The file tree of Just Files. Folders start open so the whole space reads at
 * a glance; read-only files say so.
 */
import {
  ChevronRightIcon,
  FileCodeIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import { useState, type CSSProperties } from "react";

import { cn } from "~/lib/utils";
import type { SpacesTreeNode } from "./spacesFiles";

const indent = (depth: number): CSSProperties => ({ paddingLeft: `${0.5 + depth * 0.875}rem` });

function FileGlyph(props: { name: string }) {
  const Icon = props.name.endsWith(".json")
    ? FileJsonIcon
    : props.name.endsWith(".ts")
      ? FileCodeIcon
      : FileTextIcon;
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

const ROW =
  "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent";

function TreeLevel(props: {
  nodes: readonly SpacesTreeNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-px">
      {props.nodes.map((node) => {
        if (node.kind === "file") {
          const selected = node.path === props.selectedPath;
          return (
            <li key={node.path}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => props.onSelect(node.path)}
                className={cn(ROW, selected && "bg-accent")}
                style={indent(props.depth + 1)}
              >
                <FileGlyph name={node.name} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {node.name}
                </span>
                {node.file.access === "read-only" ? (
                  // Text, not a lock: a lock means "private" everywhere else.
                  <span className="shrink-0 text-3xs text-muted-foreground">read-only</span>
                ) : null}
              </button>
            </li>
          );
        }
        const open = !props.collapsed.has(node.path);
        const Folder = open ? FolderOpenIcon : FolderIcon;
        return (
          <li key={node.path}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => props.onToggle(node.path)}
              className={ROW}
              style={indent(props.depth)}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
              />
              <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {node.name}
              </span>
            </button>
            {open ? <TreeLevel {...props} nodes={node.children} depth={props.depth + 1} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function SpacesFileTree(props: {
  root: string;
  nodes: readonly SpacesTreeNode[];
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <nav aria-label={`Files in ${props.root}`} className="flex flex-col gap-1 p-2">
      <div className="flex h-7 items-center gap-1.5 px-2">
        <FolderOpenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
          {props.root}
        </span>
      </div>
      <TreeLevel
        nodes={props.nodes}
        depth={0}
        collapsed={collapsed}
        onToggle={toggle}
        selectedPath={props.selectedPath}
        onSelect={props.onSelect}
      />
    </nav>
  );
}
