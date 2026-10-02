/**
 * Spaces: one knowledge base of everything connected sources hold plus native
 * notes, one space per Home section. UI prototype on fixtures. The open space
 * persists (see `spacesSpace.ts`); filters, the previewed item, the open note
 * and the Library / Just Files lens live in the URL so the sidebar and page
 * stay in step. Dropping files anywhere opens quick capture.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { isElectron } from "../../env";
import { openQuickCapture } from "../capture/captureModel";
import { sectionPathLabel } from "../sidebar/sections/sectionModel";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SpacesAgentView } from "./SpacesAgentView";
import type { SpacesItemFixture } from "./spacesFixtures";
import { SpacesHumanBody, type SpacesLayout } from "./SpacesHumanBody";
import {
  countBy,
  describeSync,
  itemKind,
  matchesQuery,
  openItemSearch,
  patchSpacesSearch,
  spaceSources,
  SPACES_KIND_LABEL,
} from "./spacesModel";
import { SpacesNoteEditor } from "./SpacesNoteEditor";
import { SpacesNoteHeaderActions } from "./SpacesNoteHeaderActions";
import { noteTitle, useSpaceItems, useSpacesNotes } from "./spacesNotes";
import { SpacesEmptyState, SpacesSourceProblem } from "./SpacesNotices";
import { SpacesPreviewPanel } from "./SpacesPreviewPanel";
import { useCurrentSpace, useSpacesPlace } from "./spacesSpace";
import { comingSoon, SpacesLensToggle, SpacesOverflowMenu } from "./SpacesToolbar";

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export function SpacesPage() {
  const search = useSearch({ from: "/spaces" });
  const navigate = useNavigate({ from: "/spaces" });
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<SpacesLayout>("list");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchFocusPending = useSpacesPlace((state) => state.searchFocusPending);
  const createNote = useSpacesNotes((state) => state.createNote);
  const openNote = useSpacesNotes((state) => (search.note ? state.notes[search.note] : undefined));
  const { space, sections } = useCurrentSpace();

  // The sidebar's search button asks for the page search instead of its own.
  useEffect(() => {
    if (!searchFocusPending) return;
    searchRef.current?.focus();
    useSpacesPlace.getState().clearSearchFocus();
  }, [searchFocusPending]);

  const filesLens = search.lens === "files";
  const sources = useMemo(() => spaceSources(space), [space]);
  const allItems = useSpaceItems(space);
  const sourceCounts = useMemo(() => countBy(allItems, (item) => item.source), [allItems]);
  const activeSource = sources.find((source) => source.id === search.source);
  const failedSources = sources.filter(
    (source) => source.sync === "error" && (!activeSource || source.id === activeSource.id),
  );
  const scopedItems = allItems.filter(
    (item) =>
      (!activeSource || item.source === activeSource.id) &&
      (!search.kind || itemKind(item) === search.kind),
  );
  const matchingItems = scopedItems.filter((item) => matchesQuery(item, query));
  const previewItem = filesLens ? undefined : allItems.find((item) => item.id === search.item);

  const openItem = useCallback(
    (item: SpacesItemFixture) =>
      void navigate({
        search: (prev) => patchSpacesSearch(openItemSearch(prev, item), { lens: undefined }),
      }),
    [navigate],
  );
  const selectItem = (itemId: string) => {
    const item = allItems.find((entry) => entry.id === itemId);
    if (item) openItem(item);
  };
  const showFile = useCallback(
    (itemId: string) =>
      void navigate({
        search: (prev) => patchSpacesSearch(prev, { lens: "files", item: itemId, note: undefined }),
      }),
    [navigate],
  );
  const closePreview = useCallback(
    () => void navigate({ search: (prev) => patchSpacesSearch(prev, { item: undefined }) }),
    [navigate],
  );
  const backToLibrary = () =>
    void navigate({ search: (prev) => patchSpacesSearch(prev, { note: undefined }) });
  const newPage = () => {
    const note = createNote(space.newNoteSectionId);
    void navigate({ search: { note } });
  };
  const reconnect = () => void navigate({ to: "/plugins", search: { section: "connections" } });

  const heading = activeSource
    ? activeSource.name
    : search.kind
      ? SPACES_KIND_LABEL[search.kind]
      : "All";
  const count = `${scopedItems.length} ${scopedItems.length === 1 ? "item" : "items"}`;
  const summary = activeSource ? `${count} · ${describeSync(activeSource)}` : count;

  const renderBody = () => {
    if (activeSource && (sourceCounts.get(activeSource.id) ?? 0) === 0) {
      const notes = activeSource.connector === "notes";
      return (
        <SpacesEmptyState
          source={activeSource}
          title={notes ? "No pages yet" : `Nothing from ${activeSource.name} yet`}
          description={
            notes
              ? `Pages you write in ${space.name} land here.`
              : `${activeSource.name} is connected, but nothing is synced into ${space.name}.`
          }
          action={
            <Button variant="outline" onClick={notes ? newPage : comingSoon}>
              {notes ? "New page" : "Choose what to sync"}
            </Button>
          }
        />
      );
    }
    if (filesLens) {
      return (
        <SpacesAgentView
          key={search.item ?? ""}
          space={space}
          items={matchingItems}
          allItems={allItems}
          initialItemId={search.item}
          onOpenItem={openItem}
        />
      );
    }
    return (
      <SpacesHumanBody
        items={matchingItems}
        layout={layout}
        spaceId={space.id}
        query={query}
        onClearQuery={() => setQuery("")}
        selectedId={previewItem?.id}
        onSelect={selectItem}
      />
    );
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
        onDragOver={(event) => {
          if (hasFiles(event)) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          openQuickCapture();
        }}
      >
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Spaces breadcrumb">
            <WorkspaceBreadcrumbItem>Spaces</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            {openNote ? (
              <>
                <WorkspaceBreadcrumbItem>
                  {[sectionPathLabel(openNote.space), openNote.location].join(" › ")}
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <span className="truncate">{noteTitle(openNote)}</span>
                </WorkspaceBreadcrumbItem>
              </>
            ) : (
              <WorkspaceBreadcrumbItem current>{space.label}</WorkspaceBreadcrumbItem>
            )}
          </WorkspaceBreadcrumb>
          {openNote ? (
            <SpacesNoteHeaderActions note={openNote} sections={sections} onLeave={backToLibrary} />
          ) : null}
        </WorkspacePageHeader>

        {search.note ? (
          <SpacesNoteEditor
            key={search.note}
            noteId={search.note}
            items={allItems}
            onOpenItem={openItem}
            onShowFile={showFile}
            onBack={backToLibrary}
          />
        ) : (
          <div className="relative flex min-h-0 flex-1">
            <ScrollArea className="min-h-0 flex-1">
              <WorkspacePageContainer width="expanded">
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="text-2xl font-semibold tracking-tight text-balance">
                      {heading}
                    </h1>
                    <p className="text-sm text-muted-foreground">{summary}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <InputGroup className="w-56 lg:w-64">
                      <InputGroupAddon>
                        <SearchIcon />
                      </InputGroupAddon>
                      <InputGroupInput
                        ref={searchRef}
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        placeholder={`Search ${space.name}`}
                        aria-label={`Search ${space.name}`}
                      />
                    </InputGroup>
                    <SpacesLensToggle
                      lens={filesLens ? "files" : "library"}
                      onChange={(lens) =>
                        void navigate({
                          search: (prev) =>
                            patchSpacesSearch(prev, {
                              lens: lens === "files" ? "files" : undefined,
                            }),
                        })
                      }
                    />
                    {filesLens ? null : (
                      <SpacesOverflowMenu layout={layout} onLayoutChange={setLayout} />
                    )}
                  </div>
                </div>

                {failedSources.map((source) => (
                  <SpacesSourceProblem key={source.id} source={source} onReconnect={reconnect} />
                ))}

                {renderBody()}
              </WorkspacePageContainer>
            </ScrollArea>
            {previewItem ? (
              <SpacesPreviewPanel
                key={previewItem.id}
                item={previewItem}
                space={space}
                onClose={closePreview}
                onShowFile={showFile}
              />
            ) : null}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
