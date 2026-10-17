/**
 * signalbox: in-thread Find on mobile (#792). Cmd/Ctrl+F, the command palette
 * and search results open it; each match scrolls its message into view. The
 * server counts and walks matches (`orchestration.searchThread`), the same
 * call web's Find makes.
 */
import type { LegendListRef } from "@legendapp/list/react-native";
import { useIsFocused } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, View, type TextInputInstance } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText, AppTextInput } from "../../../components/ui/AppText";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { orchestrationEnvironment } from "../../../state/orchestration";
import { useDebouncedValue } from "../../../state/queries";
import { useEnvironmentQuery } from "../../../state/query";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import {
  feedIndexForFindTarget,
  formatThreadFindCount,
  type ThreadFindStart,
} from "./thread-find-model";
import { usePendingThreadFindRequest } from "./thread-find-request";

const BAR_ENTERING = FadeIn.duration(140).reduceMotion(ReduceMotion.System);
const BAR_EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

interface FindState {
  readonly open: boolean;
  readonly query: string;
  readonly start: ThreadFindStart | undefined;
  readonly offset: number;
  /** Bumped per open so a reopened bar focuses again. */
  readonly focusRequest: number;
  readonly autoFocus: boolean;
}

const CLOSED: FindState = {
  open: false,
  query: "",
  start: undefined,
  offset: 0,
  focusRequest: 0,
  autoFocus: false,
};

function useThreadFindResults(environmentId: EnvironmentId, threadId: ThreadId, state: FindState) {
  const query = state.query.trim();
  const debouncedQuery = useDebouncedValue(query, 150);
  const settled = state.open && query.length > 0 && query === debouncedQuery;
  const result = useEnvironmentQuery(
    settled
      ? orchestrationEnvironment.threadFind({
          environmentId,
          input: {
            threadId,
            query: debouncedQuery,
            ...(state.start ? { start: state.start } : {}),
            ...(state.offset !== 0 ? { offset: state.offset } : {}),
          },
        })
      : null,
  );
  // Keep the last answer while the next step loads so the count doesn't flash.
  const [last, setLast] = useState<{ query: string; data: typeof result.data }>({
    query: "",
    data: null,
  });
  if (result.data !== null && (last.data !== result.data || last.query !== query)) {
    setLast({ query, data: result.data });
  }
  const data = result.data ?? (last.query === query ? last.data : null);
  return {
    data,
    error: result.error,
    refresh: result.refresh,
    isPending: state.open && query.length > 0 && (query !== debouncedQuery || result.isPending),
  };
}

export function ThreadFindBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly listRef: RefObject<LegendListRef | null>;
  /** Changes whenever the feed does, so a match that wasn't rendered yet gets another try. */
  readonly feed: unknown;
  readonly top: number;
}) {
  const enabled = useEnvironmentServerConfig(props.environmentId)?.threadFind === true;
  const focused = useIsFocused();
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  const [state, setState] = useState<{ key: string; find: FindState }>({
    key: threadKey,
    find: CLOSED,
  });
  const find = state.key === threadKey ? state.find : CLOSED;
  const setFind = useCallback(
    (update: (previous: FindState) => FindState) =>
      setState((previous) => ({
        key: threadKey,
        find: update(previous.key === threadKey ? previous.find : CLOSED),
      })),
    [threadKey],
  );

  const open = useCallback(
    (query?: string, start?: ThreadFindStart) =>
      setFind((previous) => ({
        ...previous,
        open: true,
        ...(query === undefined ? {} : { query, start, offset: 0 }),
        focusRequest: previous.focusRequest + 1,
        autoFocus: query === undefined || query.length === 0,
      })),
    [setFind],
  );
  const close = useCallback(() => setFind(() => CLOSED), [setFind]);

  usePendingThreadFindRequest(threadKey, enabled, (request) => open(request.query, request.start));
  const onFindCommand = useCallback(() => {
    if (!enabled || !focused) return false;
    open();
    return true;
  }, [enabled, focused, open]);
  useHardwareKeyboardCommand("focusSearch", onFindCommand);

  const results = useThreadFindResults(props.environmentId, props.threadId, find);
  const match = results.data?.match ?? null;
  const total = results.data?.totalMatches ?? 0;
  const counting = results.data?.complete === false;

  const scrolledRef = useRef<string | null>(null);
  // A reopened bar or a new query scrolls again even onto the same match.
  const matchKey =
    match === null
      ? null
      : `${find.focusRequest}:${find.query.trim()}:${match.entryId}:${match.occurrence}`;
  useEffect(() => {
    if (match === null || matchKey === null || scrolledRef.current === matchKey) return;
    const list = props.listRef.current;
    if (list === null) return;
    const index = feedIndexForFindTarget(list.getState().data, match);
    if (index === -1) return;
    scrolledRef.current = matchKey;
    list.scrollToIndex({ index, animated: true, viewPosition: 0.25 });
  }, [match, matchKey, props.feed, props.listRef]);

  const step = (delta: number) => {
    if (match === null || total === 0 || counting) return;
    setFind((previous) => ({
      ...previous,
      start: { entryId: match.entryId, occurrence: match.occurrence },
      offset: delta,
    }));
  };

  const inputRef = useRef<TextInputInstance>(null);
  useEffect(() => {
    if (find.open && find.autoFocus) inputRef.current?.focus();
  }, [find.open, find.autoFocus, find.focusRequest]);

  const status = useMemo(() => {
    if (find.query.trim().length === 0) return null;
    if (results.error !== null && results.data === null) return "error" as const;
    if (results.isPending && results.data === null) return "loading" as const;
    return null;
  }, [find.query, results.data, results.error, results.isPending]);

  if (!enabled || !find.open || !focused) return null;
  return (
    <Animated.View
      entering={BAR_ENTERING}
      exiting={BAR_EXITING}
      className="absolute inset-x-3 z-30 flex-row items-center gap-1 rounded-2xl border border-border bg-card py-1 pl-3 pr-1 shadow-md shadow-black/15"
      style={{ top: props.top + 8 }}
    >
      <SymbolView name="magnifyingglass" size={16} tintColorClassName="accent-foreground-muted" />
      <AppTextInput
        ref={inputRef}
        accessibilityLabel="Find in thread"
        placeholder="Find in thread"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        value={find.query}
        onChangeText={(query) =>
          setFind((previous) => ({ ...previous, query, start: undefined, offset: 0 }))
        }
        onSubmitEditing={() => step(1)}
        submitBehavior="submit"
        className="min-h-10 flex-1 border-0 bg-transparent px-1 py-2"
      />
      {status === "loading" ? (
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      ) : status === "error" ? (
        <FindBarButton icon="arrow.clockwise" label="Retry search" onPress={results.refresh} />
      ) : find.query.trim().length > 0 ? (
        <AppText
          textRole="caption"
          className="min-w-10 text-center text-muted-foreground tabular-nums"
          accessibilityLiveRegion="polite"
        >
          {formatThreadFindCount(results.data?.activeIndex ?? 0, total, counting)}
        </AppText>
      ) : null}
      <FindBarButton
        icon="chevron.up"
        label="Previous match"
        disabled={total === 0 || counting}
        onPress={() => step(-1)}
      />
      <FindBarButton
        icon="chevron.down"
        label="Next match"
        disabled={total === 0 || counting}
        onPress={() => step(1)}
      />
      <FindBarButton icon="xmark" label="Close find" onPress={close} />
    </Animated.View>
  );
}

function FindBarButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      className="size-9 items-center justify-center rounded-full active:opacity-70"
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColorClassName={props.disabled ? "accent-icon-subtle" : "accent-foreground"}
      />
    </Pressable>
  );
}
