/**
 * A folder's automations, connected accounts and mapped places. Folded, they
 * are one quiet row of stacked marks ("2 automations · 3 places"); anything
 * that needs you still gets its own row. Unfolded, every one gets a row. Rows
 * open the automation (on the run that needs you, shown on its workflow), the
 * account or place page (/spaces), or a repository's pull requests. A place
 * or account referenced from another folder shows there as a reference row
 * ("↗ … from Northwind team"); one that reaches the folders inside its home
 * gets a quiet marker. "⋯" is `MappedRowMenu`.
 */
import {
  linkOptions,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BookMarkedIcon,
  ChevronRightIcon,
  ChevronsDownIcon,
  WorkflowIcon,
} from "lucide-react";
import { createContext, memo, useContext } from "react";

import { cn } from "~/lib/utils";
import { automationAttention } from "../../homeAutomations/automationStatus";
import { useAssistantName } from "../../homeAutomations/useAssistantName";
import { SourceMark } from "../../spaces/SpacesGlyphs";
import { mappingHealth } from "../../spaces/spacesMappings";
import type { SpacesSearch } from "../../spaces/spacesModel";
import {
  isPullRequestPlace,
  projectPullRequestsSearch,
  usePullRequestsSupported,
  type PullRequestScope,
} from "../../spaces/spacesPullRequests";
import { useSidebar } from "../../ui/sidebar";
import { useHomeDestinations } from "./homeMoves";
import {
  EMPTY_MAPPED_INDEX,
  accountItemId,
  needsYou,
  placeItemId,
  useMappedStore,
  type MappedIndex,
  type MappedItem,
  type MappedKind,
} from "./mappedItems";
import { MappedRowMenu, type RowPlacement } from "./MappedRowMenu";
import { StatusMarker } from "./StatusMarkers";

const MAX_STACKED_MARKS = 4;

/** Where every mapped thing lives, from the tree; rows need it for their "⋯" and reference label. */
export const MappedIndexContext = createContext<MappedIndex>(EMPTY_MAPPED_INDEX);

function KindMark(props: { icon: typeof WorkflowIcon; muted?: boolean }) {
  const Icon = props.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-control-surface",
        props.muted ? "text-sidebar-muted-foreground" : "text-sidebar-foreground",
      )}
    >
      <Icon className="size-3" strokeWidth={2.25} />
    </span>
  );
}

function ItemMark(props: { item: MappedItem }) {
  const { item } = props;
  switch (item.kind) {
    case "automation":
      return <KindMark icon={WorkflowIcon} muted={!item.automation.enabled} />;
    case "account":
      return <SourceMark connector={item.source.connector} tone="sidebar" />;
    case "place":
      return <SourceMark connector={mappingHealth(item.mapping).connector} tone="sidebar" />;
    case "skill":
      return <KindMark icon={BookMarkedIcon} />;
  }
}

/** What the folded strip calls each kind; accounts are places too. */
const SUMMARY_NOUN: Readonly<Record<MappedKind, readonly [one: string, many: string]>> = {
  automation: ["automation", "automations"],
  account: ["place", "places"],
  place: ["place", "places"],
  skill: ["skill", "skills"],
};

function summary(items: readonly MappedItem[]) {
  // Keyed by the noun, so accounts and places add up to one "places" count.
  const counts = new Map<string, { many: string; count: number }>();
  for (const item of items) {
    const [one, many] = SUMMARY_NOUN[item.kind];
    const entry = counts.get(one);
    counts.set(one, { many, count: (entry?.count ?? 0) + 1 });
  }
  return [...counts]
    .map(([one, { many, count }]) => `${count} ${count === 1 ? one : many}`)
    .join(" · ");
}

/** The quiet label at the end of a row. */
function rowDetail(item: MappedItem): string | null {
  switch (item.kind) {
    case "automation":
      return item.automation.enabled ? null : "Paused";
    case "account":
      return item.source.connector === "notes" ? "Pages" : "Account";
    case "place":
      return item.mapping.what;
    case "skill":
      return "Skill";
  }
}

/** The row's id and the folder it was opened from, matched against the open page. */
const activeRowKey = (id: string, containerKey: string) => `${id}\u0000${containerKey}`;

const MappedRow = memo(function MappedRow(props: {
  item: MappedItem;
  containerKey: string;
  /** Built-in automations stay put. */
  fixed: boolean;
  pullRequestScope: PullRequestScope | undefined;
}) {
  const { item, containerKey, pullRequestScope } = props;
  const index = useContext(MappedIndexContext);
  const destinations = useHomeDestinations();
  const navigate = useNavigate();
  const router = useRouter();
  const nameText = useAssistantName();
  const { isMobile, setOpenMobile } = useSidebar();
  const pullRequestsSupported = usePullRequestsSupported();
  const activeAutomationId = useParams({
    strict: false,
    select: (params) => params.automationId ?? null,
  });
  // The open place page, or the pull requests page and the project it is scoped to.
  const activePage = useLocation({
    select: (location) => {
      if (location.pathname === "/pull-requests") {
        return `pull-requests:${(location.search as { projectId?: string }).projectId ?? ""}`;
      }
      if (location.pathname !== "/spaces") return null;
      const search = location.search as SpacesSearch;
      const id = search.account
        ? accountItemId(search.account)
        : search.mapping
          ? placeItemId(search.mapping)
          : null;
      return id ? activeRowKey(id, search.at ?? "") : null;
    },
  });
  const opensPullRequests =
    item.kind === "place" && pullRequestsSupported && isPullRequestPlace(item.mapping);
  const title = item.kind === "automation" ? nameText(item.title) : item.title;
  const isActive =
    item.kind === "automation"
      ? activeAutomationId === item.automation.id
      : opensPullRequests
        ? activePage === `pull-requests:${pullRequestScope?.id ?? ""}`
        : // A place mapped twice lights only the folder it was opened from.
          activePage === activeRowKey(item.id, containerKey) ||
          activePage === activeRowKey(item.id, "");
  const loud = needsYou(item);

  // Hover preloads the page: rows are buttons, so they don't get links' preload, and a
  // slow chunk would otherwise leave the old page up under the new URL.
  const target = () => {
    switch (item.kind) {
      case "automation": {
        // Land on the run that needs you, traced on the workflow.
        const run = automationAttention([item.automation])[0]?.run;
        return linkOptions({
          to: "/home/automations/$automationId",
          params: { automationId: item.automation.id },
          search: run ? { run: run.id, show: "workflow" as const } : {},
        });
      }
      case "account":
        return linkOptions({
          to: "/spaces",
          search: { account: item.source.id, at: containerKey },
        });
      case "place":
        return opensPullRequests
          ? linkOptions({
              to: "/pull-requests",
              search: projectPullRequestsSearch(pullRequestScope),
            })
          : linkOptions({ to: "/spaces", search: { mapping: item.mapping.id, at: containerKey } });
      case "skill":
        return linkOptions({ to: "/plugins", search: { section: "skills", skill: item.skill.id } });
    }
  };
  const visit = (preload: boolean) => {
    const options = target();
    if (preload) void router.preloadRoute(options).catch(() => undefined);
    else void navigate(options);
  };
  const open = () => {
    if (isMobile) setOpenMobile(false);
    visit(false);
  };

  const home = index.homeById.get(item.id) ?? null;
  const placement: RowPlacement = {
    shownIn: index.homesById.get(item.id) ?? [containerKey],
    home,
    references: index.referencesById.get(item.id) ?? [],
    reach: index.reachById.get(item.id) ?? "here",
  };
  // Skills have no single home; anything else shown away from its home is a reference.
  const reference = item.kind !== "skill" && home !== null && home !== containerKey;
  const homeLabel = reference
    ? (destinations.find((destination) => destination.key === home)?.label ?? "another folder")
    : null;
  const detail = homeLabel ? `from ${homeLabel.split(" › ").at(-1)}` : rowDetail(item);

  return (
    <li
      className={cn(
        "group/home-thread relative flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
        isActive
          ? "bg-sidebar-row-selected text-sidebar-foreground"
          : "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        loud ? "font-medium" : "font-normal",
        !isActive && (loud ? "text-sidebar-muted-foreground" : "text-sidebar-muted-foreground/70"),
      )}
    >
      <ItemMark item={item} />
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        onClick={open}
        onPointerEnter={() => visit(true)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-hidden after:absolute after:inset-0 after:rounded-md after:ring-ring focus-visible:after:ring-2"
      >
        {reference ? (
          <ArrowUpRightIcon
            aria-label="Reference"
            className="-mr-1 size-3 shrink-0 text-sidebar-muted-foreground/60"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5",
          !props.fixed &&
            "group-hover/home-thread:opacity-0 group-has-focus-visible/home-thread:opacity-0 group-has-data-popup-open/home-thread:opacity-0 pointer-coarse:opacity-100",
        )}
      >
        {placement.reach === "below" && !reference ? (
          <ChevronsDownIcon
            aria-label="Available to folders inside"
            className="size-3 text-sidebar-muted-foreground/50"
          />
        ) : null}
        {item.status && loud ? (
          <StatusMarker status={item.status} />
        ) : detail ? (
          <span className="text-xs font-normal text-sidebar-muted-foreground/60">{detail}</span>
        ) : null}
      </span>
      {props.fixed ? null : (
        <div className="absolute inset-y-0 right-1 z-10 flex items-center opacity-0 group-hover/home-thread:opacity-100 group-has-focus-visible/home-thread:opacity-100 group-has-data-popup-open/home-thread:opacity-100 pointer-coarse:static pointer-coarse:opacity-100">
          <MappedRowMenu
            item={item}
            title={title}
            containerKey={props.containerKey}
            placement={placement}
            reference={reference}
          />
        </div>
      )}
    </li>
  );
});

/** The folded strip plus whichever rows are showing; renders nothing for an empty folder. */
export function MappedStrip(props: {
  items: readonly MappedItem[];
  containerKey: string;
  /** Set on a real project, so a repository mapped into it opens that project's pull requests. */
  pullRequestScope?: PullRequestScope;
}) {
  const open = useMappedStore((state) => props.containerKey in state.openStrips);
  const { items, containerKey } = props;
  if (items.length === 0) return null;
  const quiet = items.filter((item) => !needsYou(item));
  const rows = open ? items : items.filter(needsYou);
  return (
    <>
      {quiet.length > 0 ? (
        <li>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => useMappedStore.getState().toggleStrip(containerKey)}
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            <span className="flex shrink-0 -space-x-1.5">
              {quiet.slice(0, MAX_STACKED_MARKS).map((item) => (
                <span key={item.id} className="rounded-md ring-2 ring-sidebar">
                  <ItemMark item={item} />
                </span>
              ))}
            </span>
            <span className="min-w-0 flex-1 truncate">{summary(open ? items : quiet)}</span>
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
          </button>
        </li>
      ) : null}
      {rows.map((item) => (
        <MappedRow
          key={item.id}
          item={item}
          containerKey={containerKey}
          // Built-ins can't be moved or removed.
          fixed={item.kind === "automation" && item.automation.system !== undefined}
          pullRequestScope={props.pullRequestScope}
        />
      ))}
    </>
  );
}
