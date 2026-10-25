/**
 * signalbox: Home search reaching inside threads (#792). The title filter's
 * rows stay the list; this section follows them with the threads only their
 * content matched, archived ones included and labelled, plus honest loading,
 * coverage and failure rows. A result opens its thread with Find on the match.
 */
import { useAtomValue } from "@effect/atom-react";
import { splitThreadSearchText } from "@t3tools/shared/threadSearch";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { SearchItemKind } from "@t3tools/contracts/signalboxSearch";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useContentSearch, type ContentSearchView } from "../../state/signalboxSearch";
import {
  findQueryForHit,
  mergeHomeSearchResults,
  SEARCH_FAILURE_COPY,
  SEARCH_ITEM_KIND_LABEL,
  searchCoverageCopy,
  searchResultKey,
  searchResultPlace,
  type HomeSearchResult,
} from "@t3tools/client-runtime/state/signalboxSearchModel";
import { folderEnvironmentsAtom } from "../../state/signalboxFolders";
import { requestThreadFindAt } from "../threads/find/thread-find-request";
import { useHomeThreadSelection } from "./home-thread-navigation";

const KIND_ICON: Record<SearchItemKind, AppSymbolName> = {
  thread: "bubble.left",
  user: "person.crop.circle",
  assistant: { ios: "sparkles", android: "auto_awesome" },
  summary: "doc.text",
  tool: "chevron.left.forwardslash.chevron.right",
  approval: "exclamationmark.shield",
  state: "info.circle",
};

interface ListedThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
}

/** Home's content search; Home reads it too, to hold "No results" while matches may come. */
export const useHomeContentSearch = useContentSearch;

/** Whether the list's empty state should wait: content search is running or found something. */
export function homeContentSearchHolds(search: ContentSearchView, query: string): boolean {
  return (
    search.supported &&
    query.trim().length > 0 &&
    (search.isPending ||
      search.hits.length > 0 ||
      search.failure !== null ||
      search.coverage !== null)
  );
}

export function HomeContentSearchSection(props: {
  readonly search: ContentSearchView;
  readonly query: string;
  /** Every thread Home knows, for live titles. */
  readonly threads: ReadonlyArray<ListedThread>;
  /** Keys (`environmentId:threadId`) of the rows Home already lists for this query. */
  readonly listedThreadKeys: ReadonlySet<string>;
}) {
  const { search } = props;
  const folderEnvironments = useAtomValue(folderEnvironmentsAtom);
  const selectThread = useHomeThreadSelection();
  const threadByKey = useMemo(
    () =>
      new Map(
        props.threads.map((thread) => [searchResultKey(thread.environmentId, thread.id), thread]),
      ),
    [props.threads],
  );
  const results = useMemo(
    () =>
      mergeHomeSearchResults({ titleMatches: [], threadByKey, hits: search.hits }).filter(
        (result) =>
          !props.listedThreadKeys.has(scopedThreadKey(result.environmentId, result.threadId)),
      ),
    [props.listedThreadKeys, search.hits, threadByKey],
  );
  if (!search.supported || props.query.trim().length === 0) return null;

  const query = props.query.trim();
  const open = (result: HomeSearchResult<ListedThread>) => {
    selectThread({ environmentId: result.environmentId, id: result.threadId });
    const findQuery = result.hit === null ? null : findQueryForHit(query, result.hit);
    if (result.hit === null || findQuery === null) return;
    requestThreadFindAt({
      threadKey: scopedThreadKey(result.environmentId, result.threadId),
      query: findQuery,
      start: { entryId: result.hit.entryId, occurrence: 0 },
    });
  };

  return (
    <View className="gap-px pt-3" accessibilityRole="list">
      {results.length > 0 || search.isPending ? (
        <Text className="px-4 pb-1 text-xs font-t3-medium text-foreground-muted">
          Inside threads
        </Text>
      ) : null}
      {results.map((result) => {
        const environment = folderEnvironments.get(result.environmentId);
        return (
          <ContentResultRow
            key={result.key}
            result={result}
            query={query}
            place={searchResultPlace({
              folders: environment?.snapshot ?? null,
              contexts: environment?.owners ?? null,
              threadId: result.threadId,
              projectId: result.projectId,
            })}
            onPress={() => open(result)}
          />
        );
      })}
      <SearchStatusRows search={search} />
    </View>
  );
}

function ContentResultRow(props: {
  readonly result: HomeSearchResult<ListedThread>;
  readonly query: string;
  readonly place: string | null;
  readonly onPress: () => void;
}) {
  const kind = props.result.hit?.kind ?? "thread";
  const label = [
    props.result.title,
    props.place,
    props.result.archived ? "Archived" : null,
    props.result.hit ? `${SEARCH_ITEM_KIND_LABEL[kind]}: ${props.result.hit.snippet}` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={props.onPress}
      className="flex-row items-start gap-3 rounded-xl px-4 py-2.5 active:opacity-70"
    >
      <View className="pt-0.5">
        <SymbolView name={KIND_ICON[kind]} size={16} tintColorClassName="accent-icon-muted" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-base font-t3-medium" numberOfLines={1}>
            {props.result.title}
          </Text>
          {props.result.moreHits > 0 ? (
            <Text className="text-xs text-foreground-muted tabular-nums">
              +{props.result.moreHits}
            </Text>
          ) : null}
        </View>
        {props.place !== null || props.result.archived ? (
          <View className="flex-row items-center gap-1.5">
            {props.place !== null ? (
              <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
                {props.place}
              </Text>
            ) : null}
            {props.result.archived ? (
              <View className="rounded-md bg-subtle px-1.5 py-px">
                <Text className="text-3xs font-t3-medium text-foreground-secondary">Archived</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {props.result.hit !== null ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            <Text className="text-xs font-t3-medium text-foreground-secondary">
              {SEARCH_ITEM_KIND_LABEL[props.result.hit.kind]}:{" "}
            </Text>
            {splitThreadSearchText(
              props.result.hit.snippet,
              findQueryForHit(props.query, props.result.hit) ?? props.query,
            ).map((part) => (
              <Text
                key={part.start}
                className={
                  part.highlighted
                    ? "text-xs font-t3-bold text-foreground"
                    : "text-xs text-foreground-muted"
                }
              >
                {part.text}
              </Text>
            ))}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function SearchStatusRows(props: { readonly search: ContentSearchView }) {
  const { search } = props;
  const coverage = searchCoverageCopy(search.coverage);
  return (
    <>
      {search.isPending ? (
        <View className="flex-row items-center gap-3 px-4 py-3" accessibilityLiveRegion="polite">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
          <Text className="text-sm text-foreground-muted">Searching inside threads…</Text>
        </View>
      ) : search.failure !== null ? (
        <StatusRow
          icon="exclamationmark.triangle"
          title={SEARCH_FAILURE_COPY[search.failure]}
          action={search.failure === "expired" ? "Search again" : "Retry"}
          onPress={search.retry}
        />
      ) : coverage !== null ? (
        <StatusRow
          icon={search.coverage?.unavailable ? "exclamationmark.triangle" : "circle.dashed"}
          title={coverage.title}
          detail={coverage.detail}
          {...(search.coverage?.unavailable ? { action: "Retry", onPress: search.retry } : {})}
        />
      ) : null}
      {search.canLoadMore ? (
        <Pressable
          accessibilityRole="button"
          onPress={search.loadMore}
          className="items-center px-4 py-3 active:opacity-70"
        >
          <Text className="text-sm font-t3-medium text-foreground-secondary">More results</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function StatusRow(props: {
  readonly icon: AppSymbolName;
  readonly title: string;
  readonly detail?: string;
  readonly action?: string;
  readonly onPress?: () => void;
}) {
  return (
    <View className="flex-row items-start gap-3 px-4 py-3" accessibilityLiveRegion="polite">
      <View className="pt-0.5">
        <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon-muted" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm text-foreground-secondary">{props.title}</Text>
        {props.detail ? (
          <Text className="text-xs text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
      {props.action && props.onPress ? (
        <Pressable accessibilityRole="button" onPress={props.onPress} hitSlop={8}>
          <Text className="text-sm font-t3-medium text-foreground">{props.action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
