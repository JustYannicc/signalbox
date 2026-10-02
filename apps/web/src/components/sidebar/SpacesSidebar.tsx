/**
 * Spaces: the library view of the sidebar. The header switches the space (a
 * Home section, filtered by Focus) and holds the one Connect entry; kind and
 * source rows filter the Spaces page through its URL (keeping the lens), and
 * recents open an item's preview or a note. Pull requests are part of Spaces:
 * their row opens the real page, where this panel stays mounted, so nothing
 * here depends on the /spaces route being active. Prototype on fixtures.
 */
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  FileTextIcon,
  LibraryIcon,
  LinkIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  PlugIcon,
  SearchIcon,
  SquareCheckIcon,
  SquarePenIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { ItemTypeIcon, SourceMark, SyncDot } from "../spaces/SpacesGlyphs";
import {
  countBy,
  describeSync,
  itemKind,
  openItemSearch,
  spaceSources,
  SPACES_KIND_LABEL,
  validateSpacesSearch,
  type SpacesKind,
  type SpacesSearch,
} from "../spaces/spacesModel";
import { useSpaceItems, useSpacesNotes } from "../spaces/spacesNotes";
import { pullRequestsSearch, usePullRequestsSupported } from "../spaces/spacesPullRequests";
import { sectionName, useCurrentSpace, useSpacesPlace } from "../spaces/spacesSpace";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { HomeSectionLabel } from "./HomeSidebarTree";
import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const RECENT_COUNT = 5;
const KIND_ICON: Record<SpacesKind, LucideIcon> = {
  documents: FileTextIcon,
  files: PaperclipIcon,
  messages: MessagesSquareIcon,
  issues: SquareCheckIcon,
  links: LinkIcon,
};
const KINDS = Object.keys(KIND_ICON) as SpacesKind[];

function Count(props: { value: number }) {
  return (
    <span className="shrink-0 text-xs font-normal text-sidebar-muted-foreground/70 tabular-nums">
      {props.value}
    </span>
  );
}

function SpacesLinkRow(props: {
  search: SpacesSearch;
  isActive: boolean;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={props.isActive}
        render={<Link to="/spaces" search={props.search} onClick={props.onNavigate} />}
      >
        {props.children}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SpacesSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation({
    select: (current) => ({ pathname: current.pathname, search: current.search }),
  });
  const onSpacesPage = location.pathname === "/spaces";
  const onPullRequests = location.pathname === "/pull-requests";
  const search: SpacesSearch = onSpacesPage
    ? validateSpacesSearch(location.search as Record<string, unknown>)
    : {};
  const { space, spaces } = useCurrentSpace();
  const items = useSpaceItems(space);
  const sources = spaceSources(space);
  const kindCounts = countBy(items, itemKind);
  const sourceCounts = countBy(items, (item) => item.source);
  const createNote = useSpacesNotes((state) => state.createNote);
  const pullRequestsSupported = usePullRequestsSupported();
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false);
  };
  // Filters keep the lens, so browsing by kind or source works in Just Files too.
  const lens = search.lens ? { lens: search.lens } : {};
  const noFilter = onSpacesPage && !search.kind && !search.source && !search.note;

  const switchSpace = (sectionId: string) => {
    useSpacesPlace.getState().setSectionId(sectionId);
    // Source filters and open items belong to the old space.
    if (onSpacesPage) void navigate({ to: "/spaces", search: lens });
  };
  const newPage = () => {
    const note = createNote(space.newNoteSectionId);
    onNavigate();
    void navigate({ to: "/spaces", search: { note } });
  };
  const focusSearch = () => {
    useSpacesPlace.getState().requestSearchFocus();
    if (!onSpacesPage || search.note) void navigate({ to: "/spaces", search: lens });
  };

  return (
    <>
      <SidebarContent
        fixedHeader={
          <div className="flex flex-col gap-2 p-2 pb-1">
            <div className="flex h-8 items-center gap-1">
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${space.label}. Switch space`}
                      className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-2.5 text-left outline-none hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover"
                    />
                  }
                >
                  <span className="min-w-0 truncate text-base font-semibold tracking-tight text-sidebar-foreground">
                    {space.name}
                  </span>
                  <ChevronDownIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-sidebar-muted-foreground"
                  />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuRadioGroup
                    value={space.id}
                    onValueChange={(value) => switchSpace(String(value))}
                  >
                    {spaces.map((option) => (
                      <MenuRadioItem key={option.id} value={option.id}>
                        {option.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              <SidebarHeaderIconButton label={`Search ${space.name}`} onClick={focusSearch}>
                <SearchIcon />
              </SidebarHeaderIconButton>
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={newPage}>
                  <SquarePenIcon />
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">New page</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={
                    <Link to="/plugins" search={{ section: "connections" }} onClick={onNavigate} />
                  }
                >
                  <PlugIcon />
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">Connect</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        }
      >
        <div className="flex flex-col px-2 pb-2">
          <nav aria-label="Browse by kind">
            <ul className="flex flex-col gap-px pt-2">
              <SpacesLinkRow search={lens} isActive={noFilter} onNavigate={onNavigate}>
                <LibraryIcon />
                <span className="min-w-0 flex-1 truncate">All</span>
                <Count value={items.length} />
              </SpacesLinkRow>
              {KINDS.map((kind) => {
                const Icon = KIND_ICON[kind];
                return (
                  <SpacesLinkRow
                    key={kind}
                    search={{ kind, ...lens }}
                    isActive={
                      onSpacesPage && search.kind === kind && !search.source && !search.note
                    }
                    onNavigate={onNavigate}
                  >
                    <Icon />
                    <span className="min-w-0 flex-1 truncate">{SPACES_KIND_LABEL[kind]}</span>
                    <Count value={kindCounts.get(kind) ?? 0} />
                  </SpacesLinkRow>
                );
              })}
              {pullRequestsSupported ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={onPullRequests}
                    render={
                      <Link
                        to="/pull-requests"
                        search={() => pullRequestsSearch()}
                        onClick={onNavigate}
                      />
                    }
                  >
                    <PullRequestGlyph.pullRequest />
                    <span className="min-w-0 flex-1 truncate">Pull requests</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </ul>
          </nav>
          <section aria-label="Sources">
            <HomeSectionLabel>Sources</HomeSectionLabel>
            <ul className="flex flex-col gap-px">
              {sources.map((source) => (
                <SpacesLinkRow
                  key={source.id}
                  search={{ source: source.id, ...lens }}
                  isActive={onSpacesPage && search.source === source.id && !search.note}
                  onNavigate={onNavigate}
                >
                  <SourceMark connector={source.connector} tone="sidebar" />
                  <span className="min-w-0 flex-1 truncate">
                    {source.name}
                    {/* Sources from a nested section say whose they are. */}
                    {source.space === space.id ? null : (
                      <span className="text-sidebar-muted-foreground">
                        {" "}
                        · {sectionName(source.space)}
                      </span>
                    )}
                  </span>
                  {/* Healthy is the default; only a sync in progress or a failure is marked. */}
                  {source.sync === "synced" ? null : (
                    <SyncDot state={source.sync} label={describeSync(source)} />
                  )}
                  <Count value={sourceCounts.get(source.id) ?? 0} />
                </SpacesLinkRow>
              ))}
            </ul>
          </section>
          <section aria-label="Recents">
            <HomeSectionLabel>Recents</HomeSectionLabel>
            <ul className="flex flex-col gap-px">
              {items.slice(0, RECENT_COUNT).map((item) => (
                <SpacesLinkRow
                  key={item.id}
                  search={openItemSearch(search, item)}
                  isActive={onSpacesPage && (search.item === item.id || search.note === item.id)}
                  onNavigate={onNavigate}
                >
                  <ItemTypeIcon type={item.type} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                </SpacesLinkRow>
              ))}
            </ul>
          </section>
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
