/**
 * Home's Search (the command palette) searching inside threads through the
 * Signalbox search service (#792). The palette's own title filter keeps its
 * "Threads" group; this adds what only the content matched, archived threads
 * included, plus honest loading, coverage and failure rows.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SearchItemKind, ThreadSearchHit } from "@t3tools/contracts/signalboxSearch";
import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  HourglassIcon,
  LoaderIcon,
  MessageSquareIcon,
  RotateCwIcon,
  ScrollTextIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import { environmentContextsAtom } from "../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../state/signalboxFolders";
import {
  useContentSearch,
  useContentSearchEnvironmentIds,
  type ContentSearchView,
} from "../../state/signalboxSearch";
import {
  findQueryForHit,
  mergeHomeSearchResults,
  SEARCH_FAILURE_COPY,
  SEARCH_ITEM_KIND_LABEL,
  searchResultKey,
  searchCoverageCopy,
  searchResultPlace,
  type HomeSearchResult,
  type SearchTitleThread,
} from "@t3tools/client-runtime/state/signalboxSearchModel";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { requestThreadFindAt } from "../chat/threadFindRequest";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../CommandPalette.logic";
import { Badge } from "../ui/badge";
import { HighlightedSearchText } from "../ThreadSearchMatch";

const SEARCH_ITEM_KIND_ICON: Record<SearchItemKind, LucideIcon> = {
  thread: MessageSquareIcon,
  user: UserRoundIcon,
  assistant: BotIcon,
  summary: ScrollTextIcon,
  tool: WrenchIcon,
  approval: ShieldQuestionIcon,
  state: ActivityIcon,
};

const CONTENT_GROUP_VALUE = "signalbox-content-search";
const THREADS_GROUP_VALUE = "threads-search";

function SearchHitExcerpt(props: { kind: SearchItemKind; snippet: string; query: string }) {
  return (
    <span className="block truncate">
      <span className="text-muted-foreground">{SEARCH_ITEM_KIND_LABEL[props.kind]}:</span>{" "}
      <HighlightedSearchText text={props.snippet} query={props.query} />
    </span>
  );
}

function SearchResultPlace(props: { place: string | null; archived: boolean }) {
  if (props.place === null && !props.archived) return null;
  return (
    <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-xs text-muted-foreground/70">
      {props.place === null ? null : <span className="truncate">{props.place}</span>}
      {props.archived ? (
        <Badge variant="secondary" size="sm">
          Archived
        </Badge>
      ) : null}
    </span>
  );
}

function statusItem(
  value: string,
  title: string,
  Icon: LucideIcon,
  description?: string,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `${CONTENT_GROUP_VALUE}:${value}`,
    searchTerms: [],
    title,
    ...(description === undefined ? {} : { description }),
    icon: <Icon className={ITEM_ICON_CLASS} />,
    disabled: true,
    run: async () => {},
  };
}

function actionItem(
  value: string,
  title: string,
  Icon: LucideIcon,
  run: () => void,
  description?: string,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: `${CONTENT_GROUP_VALUE}:${value}`,
    searchTerms: [],
    title,
    ...(description === undefined ? {} : { description }),
    icon: <Icon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => run(),
  };
}

function statusItems(search: ContentSearchView): CommandPaletteActionItem[] {
  const items: CommandPaletteActionItem[] = [];
  const coverage = searchCoverageCopy(search.coverage);
  if (search.isPending) {
    items.push(statusItem("loading", "Searching inside threads…", LoaderIcon));
  } else if (search.failure !== null) {
    items.push(
      actionItem(
        "retry",
        search.failure === "expired" ? "Search again" : "Retry search",
        RotateCwIcon,
        search.retry,
        SEARCH_FAILURE_COPY[search.failure],
      ),
    );
  } else if (coverage !== null) {
    items.push(
      search.coverage?.unavailable
        ? actionItem("retry", coverage.title, RotateCwIcon, search.retry, coverage.detail)
        : statusItem("partial", coverage.title, HourglassIcon, coverage.detail),
    );
  }
  if (search.canLoadMore) {
    items.push(actionItem("more", "More results", ChevronDownIcon, search.loadMore));
  }
  return items;
}

export interface ContentSearchPalette {
  /** Environments the legacy message search should still cover. */
  readonly legacyEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly isPending: boolean;
  /** Adds the content group after the palette's own filtering ran. */
  readonly applyToGroups: (groups: CommandPaletteGroup[]) => CommandPaletteGroup[];
}

export function useContentSearchPalette<T extends SearchTitleThread>(input: {
  /** The palette's query; empty in submenus and actions-only mode. */
  readonly query: string;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** Every thread the palette lists, for live titles. */
  readonly threads: ReadonlyArray<T>;
  readonly openThread: (thread: { environmentId: EnvironmentId; id: T["id"] }) => Promise<void>;
}): ContentSearchPalette {
  const query = input.query.startsWith(">") ? "" : input.query;
  const search = useContentSearch(query);
  const contentEnvironmentIds = useContentSearchEnvironmentIds();
  const folders = useAtomValue(environmentFoldersAtom);
  const contexts = useAtomValue(environmentContextsAtom);
  const threadByKey = new Map(
    input.threads.map((thread) => [searchResultKey(thread.environmentId, thread.id), thread]),
  );
  const results = mergeHomeSearchResults({ titleMatches: [], threadByKey, hits: search.hits });
  const legacyEnvironmentIds = input.environmentIds.filter(
    (environmentId) => !contentEnvironmentIds.includes(environmentId),
  );

  const openResult = (result: HomeSearchResult<T>) => async () => {
    await input.openThread({ environmentId: result.environmentId, id: result.threadId });
    const findQuery = result.hit === null ? null : findQueryForHit(query, result.hit);
    if (result.hit === null || findQuery === null) return;
    requestThreadFindAt({
      threadKey: scopedThreadKey(scopeThreadRef(result.environmentId, result.threadId)),
      query: findQuery,
      start: { entryId: result.hit.entryId, occurrence: 0 },
    });
  };

  const resultItem = (result: HomeSearchResult<T>): CommandPaletteActionItem => {
    const Icon = SEARCH_ITEM_KIND_ICON[result.hit?.kind ?? "thread"];
    const place = searchResultPlace({
      folders: folders.get(result.environmentId)?.snapshot ?? null,
      contexts: contexts.get(result.environmentId) ?? null,
      threadId: result.threadId,
      projectId: result.projectId,
    });
    const createdAt = result.hit?.createdAt ?? null;
    return {
      kind: "action",
      value: `${CONTENT_GROUP_VALUE}:${result.key}`,
      searchTerms: [],
      title: result.title,
      ...(result.hit === null
        ? {}
        : {
            description: (
              <SearchHitExcerpt
                kind={result.hit.kind}
                snippet={result.hit.snippet}
                query={findQueryForHit(query, result.hit) ?? query.trim()}
              />
            ),
          }),
      titleTrailingContent: (
        <>
          {result.moreHits > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
              +{result.moreHits}
            </span>
          ) : null}
          <SearchResultPlace place={place} archived={result.archived} />
        </>
      ),
      ...(createdAt === null ? {} : { timestamp: formatRelativeTimeLabel(createdAt) }),
      icon: (
        <Icon
          className={ITEM_ICON_CLASS}
          aria-label={SEARCH_ITEM_KIND_LABEL[result.hit?.kind ?? "thread"]}
        />
      ),
      run: openResult(result),
    };
  };

  const applyToGroups = (groups: CommandPaletteGroup[]): CommandPaletteGroup[] => {
    if (!search.supported || query.trim().length === 0) return groups;
    // A thread the title filter already lists shows once, in its own group.
    const listed = new Set(
      groups
        .find((group) => group.value === THREADS_GROUP_VALUE)
        ?.items.map((item) => item.value) ?? [],
    );
    const contentResults = results.filter((result) => !listed.has(`thread:${result.threadId}`));
    const listedMatches = new Map<string, ThreadSearchHit>(
      results.flatMap((result) =>
        listed.has(`thread:${result.threadId}`) &&
        (result.hit?.kind === "user" || result.hit?.kind === "assistant")
          ? [[`thread:${result.threadId}`, result.hit] as const]
          : [],
      ),
    );
    const withMatches = groups.map((group) =>
      group.value !== THREADS_GROUP_VALUE || listedMatches.size === 0
        ? group
        : {
            ...group,
            items: group.items.map((item) => {
              const hit = listedMatches.get(item.value);
              return hit === undefined || item.threadContentMatch !== undefined
                ? item
                : {
                    ...item,
                    threadContentMatch: {
                      source: hit.kind === "user" ? ("user" as const) : ("assistant" as const),
                      snippet: hit.snippet,
                      query: query.trim(),
                    },
                  };
            }),
          },
    );
    const items = [...contentResults.map(resultItem), ...statusItems(search)];
    if (items.length === 0) return withMatches;
    const group = { value: CONTENT_GROUP_VALUE, label: "Inside threads", items };
    const threadsIndex = withMatches.findIndex(
      (candidate) => candidate.value === THREADS_GROUP_VALUE,
    );
    return threadsIndex === -1
      ? [...withMatches, group]
      : [...withMatches.slice(0, threadsIndex + 1), group, ...withMatches.slice(threadsIndex + 1)];
  };

  return {
    legacyEnvironmentIds,
    isPending: search.isPending,
    applyToGroups,
  };
}
