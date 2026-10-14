/**
 * How the folder tree reuses the Home sidebar's thread list
 * (`SidebarProjectItem` in LegacySidebar): the threads living at one home,
 * drawn from all of their owner's projects, without a project header.
 */
import type { ContextMenuItem, ScopedProjectRef } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../../types";

export interface SidebarThreadScope {
  /** Its "Show more" key. */
  readonly listKey: string;
  /** Where its threads can come from: every project of the home's owner. */
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  /** Whether a thread lives at this home. */
  readonly includes: (thread: SidebarThreadSummary) => boolean;
  /** A thread's own project, for its path and settings: the list's is only its owner's files. */
  readonly projectOf: (thread: SidebarThreadSummary) => SidebarProjectSnapshot | undefined;
  /** More entries for a thread's menu, and what choosing one does; true when it handled it. */
  readonly threadMenu: (thread: SidebarThreadSummary) => {
    readonly items: ReadonlyArray<ContextMenuItem<string>>;
    readonly select: (clicked: string) => boolean;
  };
}
