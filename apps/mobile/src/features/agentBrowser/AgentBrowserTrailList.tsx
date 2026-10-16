import {
  agentBrowserPlaceLabel,
  agentBrowserStepLabel,
  agentBrowserStepTime,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserFrame";
import type { AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";
import { memo, useEffect, useRef } from "react";
import { FlatList, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";

/**
 * Every finished step of the agent's browsing, oldest first. Picking one shows
 * the page as that step left it. Follows new steps while scrolled to the end.
 */
export const AgentBrowserTrailList = memo(function AgentBrowserTrailList(props: {
  readonly steps: ReadonlyArray<AgentBrowserStep>;
  /** The step the mirror shows, live or picked. */
  readonly shownStepId: string | null;
  readonly onSelect: (stepId: string) => void;
}) {
  const listRef = useRef<FlatList<AgentBrowserStep>>(null);
  const pinnedToEndRef = useRef(true);
  const count = props.steps.length;

  useEffect(() => {
    if (count > 0 && pinnedToEndRef.current) listRef.current?.scrollToEnd({ animated: false });
  }, [count]);

  return (
    <View accessibilityLabel="Steps" className="max-h-56 border-t border-border-subtle">
      <AppText textRole="caption" className="px-4 pt-2 pb-1 font-t3-medium text-foreground-muted">
        Steps {count}
      </AppText>
      <FlatList
        ref={listRef}
        data={props.steps}
        keyExtractor={(step) => step.stepId}
        extraData={props.shownStepId}
        onContentSizeChange={() => {
          if (pinnedToEndRef.current) listRef.current?.scrollToEnd({ animated: false });
        }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          pinnedToEndRef.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height < 8;
        }}
        scrollEventThrottle={100}
        contentContainerClassName="px-2 pb-2"
        renderItem={({ item: step }) => {
          const shown = step.stepId === props.shownStepId;
          const label = agentBrowserStepLabel(step.action);
          const place = agentBrowserPlaceLabel(step.title, step.url, step.url);
          const time = agentBrowserStepTime(step.endedAt);
          return (
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={[label, place, time].filter(Boolean).join(", ")}
              accessibilityState={{ selected: shown }}
              onPress={() => props.onSelect(step.stepId)}
              className={cn("rounded-xl", shown && "bg-subtle-strong")}
            >
              <View className="min-h-11 flex-row items-center gap-2 px-2.5 py-2">
                <AppText textRole="footnote" className="shrink-0 text-foreground">
                  {label}
                </AppText>
                <AppText
                  textRole="footnote"
                  numberOfLines={1}
                  className="min-w-0 flex-1 text-foreground-muted"
                >
                  {place}
                </AppText>
                <AppText textRole="caption" className="shrink-0 tabular-nums text-foreground-muted">
                  {time}
                </AppText>
              </View>
            </RowPressable>
          );
        }}
      />
    </View>
  );
});
