/**
 * Home: the section-tree view of the thread sidebar. Title and search on top,
 * then top-level items and Sections › Projects › items, filtered by Focus.
 * New chat and the assistant sit above every view in `SidebarQuickActions`.
 */
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useParams, useRouter } from "@tanstack/react-router";
import { SearchIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useEnvironments } from "../../state/environments";
import { useThreadSearch } from "../../state/queries";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { SidebarContent, SidebarInput, useSidebar } from "../ui/sidebar";
import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { HomeSidebarTree } from "./HomeSidebarTree";
import { useArchiveHomeThread, type HomeThreadRowContext } from "./HomeThreadRow";
import { HomeSearchResults, useHomeSearch } from "./sections/HomeSearch";
import { useHomeSectionTree } from "./sections/useHomeSectionTree";
import { useHomeSidebarData } from "./useHomeSidebarData";
import { useHomeThreadShortcuts } from "./useHomeThreadShortcuts";

export function HomeSidebar() {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const { archivedThreads, projectEntries, projectNameByThreadKey, providerEntriesByEnvironment } =
    useHomeSidebarData();
  const activeThreadRef = useParams({ strict: false, select: resolveThreadRouteRef });
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const sectionTree = useHomeSectionTree({ projectEntries, activeThreadKey });

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const openThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      closeMobileSidebar();
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [closeMobileSidebar, router],
  );

  const handleNewThreadInProject = useCallback(
    (projectRef: ScopedProjectRef) => {
      closeMobileSidebar();
      void newThreadContext.handleNewThread(projectRef);
    },
    [closeMobileSidebar, newThreadContext],
  );
  const archiveThread = useArchiveHomeThread();
  const rowContext = useMemo<HomeThreadRowContext>(
    () => ({
      activeThreadKey,
      providerEntriesByEnvironment,
      onOpenThread: openThread,
      onArchiveThread: archiveThread,
    }),
    [activeThreadKey, archiveThread, openThread, providerEntriesByEnvironment],
  );
  // Shortcuts walk the real threads on screen, in order.
  useHomeThreadShortcuts({
    orderedThreads: sectionTree.orderedThreads,
    activeThreadKey,
    onOpenThread: openThread,
  });
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  // Search: every Home item; threads also match PRs and messages, like the Pipeline.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const { environments } = useEnvironments();
  const searchEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, searchQuery);
  const serverMatchKeys = useMemo(
    () => new Set(threadSearch.matches.map((match) => threadSearchMatchKey(match))),
    [threadSearch.matches],
  );
  const openThreadShell = useCallback(
    (thread: {
      environmentId: ScopedThreadRef["environmentId"];
      id: ScopedThreadRef["threadId"];
    }) => openThread({ environmentId: thread.environmentId, threadId: thread.id }),
    [openThread],
  );
  const searchResults = useHomeSearch({
    query: searchQuery,
    projectEntries,
    projectNameByThreadKey,
    serverMatchKeys,
    tree: sectionTree,
    openThread: openThreadShell,
  });
  const isSearching = searchOpen && searchQuery.trim().length > 0;
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setHighlightedIndex(0);
  }, []);
  const selectSearchResult = (index: number) => {
    const result = searchResults[index];
    if (!result) return;
    closeSearch();
    closeMobileSidebar();
    result.open();
  };
  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (searchResults.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedIndex((index) => (index + step + searchResults.length) % searchResults.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectSearchResult(Math.min(highlightedIndex, searchResults.length - 1));
    }
  };

  return (
    <>
      <SidebarContent
        fixedHeader={
          <div className="flex flex-col gap-2 p-2 pb-1">
            <div className="flex h-8 items-center gap-1 pl-2.5">
              {searchOpen ? (
                <>
                  <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                  <SidebarInput
                    ref={searchInputRef}
                    nativeInput
                    autoFocus
                    type="search"
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.currentTarget.value);
                      setHighlightedIndex(0);
                    }}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search"
                    aria-label="Search"
                    className="min-w-0 flex-1"
                  />
                  <SidebarHeaderIconButton label="Close search" onClick={closeSearch}>
                    <XIcon />
                  </SidebarHeaderIconButton>
                </>
              ) : (
                <>
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-sidebar-foreground">
                    Home
                  </h2>
                  <SidebarHeaderIconButton label="Search" onClick={() => setSearchOpen(true)}>
                    <SearchIcon />
                  </SidebarHeaderIconButton>
                </>
              )}
            </div>
          </div>
        }
      >
        {isSearching ? (
          <HomeSearchResults
            results={searchResults}
            pending={threadSearch.isPending}
            highlightedIndex={highlightedIndex}
            onHighlight={setHighlightedIndex}
            onSelect={selectSearchResult}
          />
        ) : (
          <HomeSidebarTree
            tree={sectionTree}
            hasProjects={projectEntries.length > 0}
            archivedThreads={archivedThreads}
            projectNameByThreadKey={projectNameByThreadKey}
            rowContext={rowContext}
            onNewThread={handleNewThreadInProject}
            onAddProject={openAddProject}
          />
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
