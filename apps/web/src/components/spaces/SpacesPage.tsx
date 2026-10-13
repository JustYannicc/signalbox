/**
 * The place page: one connected account at the level it is connected at (its
 * items no mapped place covers, with a switch to see all of them), one mapped
 * place inside it, or everything in sight when no place is set. Places open
 * from Home folders; the breadcrumb reads like the folder path. The previewed
 * item, the open note and the Library / Just Files lens live in the URL too. A
 * Notes account is that level's native pages, so "New page" lands there.
 * Dropping files anywhere opens quick capture.
 */
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useMemo, useState, type DragEvent } from "react";

import { isElectron } from "../../env";
import { openQuickCapture } from "../capture/captureModel";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useFocusedLevel } from "../sidebar/focus/focusStore";
import { activeMappings, useMappedStore } from "../sidebar/sections/mappedItems";
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
import { matchesQuery, openItemSearch, patchSpacesSearch, spaceSources } from "./spacesModel";
import { SpacesNoteEditor } from "./SpacesNoteEditor";
import { SpacesNoteHeaderActions } from "./SpacesNoteHeaderActions";
import { noteTitle, useSpaceItems, useSpacesNotes } from "./spacesNotes";
import { SpacesEmptyState, SpacesSourceProblem } from "./SpacesNotices";
import {
  inPlace,
  placeLevel,
  placeSummary,
  placeTitle,
  resolvePlace,
  useLevelLabel,
} from "./spacesPlace";
import { SpacesPreviewPanel } from "./SpacesPreviewPanel";
import { pullRequestsSearch, usePullRequestsSupported } from "./spacesPullRequests";
import { everythingSpace, sectionSpace, visibleSections } from "./spacesSpace";
import { comingSoon, SpacesLensToggle, SpacesOverflowMenu } from "./SpacesToolbar";

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export function SpacesPage() {
  const search = useSearch({ from: "/spaces" });
  const navigate = useNavigate({ from: "/spaces" });
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<SpacesLayout>("list");
  const createNote = useSpacesNotes((state) => state.createNote);
  const openNote = useSpacesNotes((state) => (search.note ? state.notes[search.note] : undefined));
  const homeOverrides = useMappedStore((state) => state.homes);
  const pullRequestsSupported = usePullRequestsSupported();
  const mode = useFocusedLevel();

  const place = useMemo(() => resolvePlace(search), [search]);
  const source = place.kind === "everything" ? undefined : place.source;
  const sections = useMemo(() => visibleSections(mode), [mode]);
  const space = useMemo(
    () => (source && sectionSpace(source.space)) || everythingSpace(sections),
    [sections, source],
  );
  const levelText = useLevelLabel(placeLevel(place, search.at, homeOverrides));
  const mappings = useMemo(() => activeMappings(homeOverrides), [homeOverrides]);

  const filesLens = search.lens === "files";
  const allItems = useSpaceItems(space);
  const accountItems = source ? allItems.filter((item) => item.source === source.id) : allItems;
  const scopedItems = allItems.filter((item) => inPlace(place, item, mappings));
  const matchingItems = scopedItems.filter((item) => matchesQuery(item, query));
  const previewItem = filesLens ? undefined : allItems.find((item) => item.id === search.item);
  const failedSources = (source ? [source] : spaceSources(space)).filter(
    (entry) => entry.sync === "error",
  );
  const notesAccount = place.kind === "account" && source?.connector === "notes";

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
    if (!source) return;
    const note = createNote(source.space);
    void navigate({ search: (prev) => patchSpacesSearch(prev, { note, item: undefined }) });
  };
  const toggleAll = () =>
    void navigate({
      search: (prev) => patchSpacesSearch(prev, { all: prev.all ? undefined : true }),
    });
  const reconnect = () => void navigate({ to: "/plugins", search: { section: "connections" } });

  const placeName = placeTitle(place);
  const summary = placeSummary(place, scopedItems.length, accountItems.length);
  // Seeing the whole account only means something when places hold some of it.
  const canToggleAll = place.kind === "account" && accountItems.length !== scopedItems.length;

  const renderBody = () => {
    if (source && accountItems.length === 0) {
      const notes = source.connector === "notes";
      return (
        <SpacesEmptyState
          source={source}
          title={notes ? "No pages yet" : `Nothing from ${source.name} yet`}
          description={
            notes
              ? `Pages you write in ${space.label} land here.`
              : `${source.name} is connected, but nothing is synced into ${space.label}.`
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
        emptyDescription={
          place.kind === "account"
            ? `Everything in ${placeName} sits in a mapped place.`
            : undefined
        }
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
          <WorkspaceBreadcrumb ariaLabel="Place breadcrumb">
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
              <>
                <WorkspaceBreadcrumbItem>{levelText}</WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>{placeName}</WorkspaceBreadcrumbItem>
              </>
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
                      {placeName}
                    </h1>
                    <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                      {summary}
                      {canToggleAll || search.all ? (
                        <Button size="micro" variant="ghost-muted" onClick={toggleAll}>
                          {search.all
                            ? "Only what no place covers"
                            : `Show all ${accountItems.length}`}
                        </Button>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {notesAccount ? (
                      <Button variant="outline" onClick={newPage}>
                        <SquarePenIcon />
                        New page
                      </Button>
                    ) : null}
                    {source?.connector === "github" && pullRequestsSupported ? (
                      <Button
                        variant="outline"
                        render={<Link to="/pull-requests" search={() => pullRequestsSearch()} />}
                      >
                        <PullRequestGlyph.pullRequest />
                        Pull requests
                      </Button>
                    ) : null}
                    <InputGroup className="w-56 lg:w-64">
                      <InputGroupAddon>
                        <SearchIcon />
                      </InputGroupAddon>
                      <InputGroupInput
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        placeholder={`Search ${placeName}`}
                        aria-label={`Search ${placeName}`}
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

                {failedSources.map((entry) => (
                  <SpacesSourceProblem key={entry.id} source={entry} onReconnect={reconnect} />
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
