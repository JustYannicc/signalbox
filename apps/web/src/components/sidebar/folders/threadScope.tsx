/**
 * The seam through which the folder tree reuses the Home sidebar's thread
 * list (`SidebarProjectItem` in LegacySidebar, an upstream file). Inside a
 * scope, the list shows the threads living at one folder, drawn from all of
 * their owner's projects, and has no project header.
 */
import type { ContextMenuItem, ScopedProjectRef } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

import type { SidebarThreadSummary } from "../../../types";

export interface SidebarThreadScope {
  /** The threads living at this folder (or top level), already grouped. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  /** The open thread's key, wherever its project is. */
  readonly activeThreadKey: string | null;
  /** "Project settings" for a thread: its own project's, not the list's. */
  readonly settingsProjectKey: (thread: SidebarThreadSummary) => string | undefined;
  /** More entries for a thread's menu, and what choosing one does; true when it handled it. */
  readonly threadMenu: (thread: SidebarThreadSummary) => {
    readonly items: ReadonlyArray<ContextMenuItem<string>>;
    readonly select: (clicked: string) => boolean;
  };
}

/** What a scoped list fetches by project: nothing, since the scope brings its threads. */
export const NO_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = [];

export const SidebarThreadScopeContext = createContext<SidebarThreadScope | null>(null);

/** The scope a thread list renders in; null for an ordinary project row. */
export function useSidebarThreadScope(): SidebarThreadScope | null {
  return useContext(SidebarThreadScopeContext);
}

/** A project row's header, which a folder's thread list doesn't render. Keeps upstream's class. */
export function SidebarProjectHeader(props: { children: ReactNode }) {
  return useSidebarThreadScope() === null ? (
    <div className="group/project-header relative">{props.children}</div>
  ) : null;
}
