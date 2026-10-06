import type { AutomationErrorDetail, AutomationRunLog } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

/**
 * A failure as the engine explained it: the message, why it happened, how to
 * fix it, and a link to read more. Steps and runs from older servers only
 * have the message.
 */
export function ErrorDetails(props: {
  readonly error: string;
  readonly detail: AutomationErrorDetail | null | undefined;
  /** Lines of the message shown before it's cut; the rest stays selectable in full elsewhere. */
  readonly numberOfLines?: number;
}) {
  const { why, fix, link } = props.detail ?? { why: null, fix: null, link: null };
  return (
    <View className="gap-1">
      <Text
        className="text-sm leading-normal text-danger-foreground"
        numberOfLines={props.numberOfLines}
        selectable
      >
        {props.error}
      </Text>
      {why ? (
        <Text className="text-sm leading-normal text-foreground-muted" selectable>
          {why}
        </Text>
      ) : null}
      {fix ? (
        <Text className="text-sm leading-normal text-foreground" selectable>
          <Text className="font-t3-medium text-foreground">How to fix: </Text>
          {fix}
        </Text>
      ) : null}
      {link ? (
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens in your browser"
          hitSlop={8}
          onPress={() =>
            void tryOpenExternalUrl(link, "markdown-link").then((opened) => {
              if (!opened) Alert.alert("Couldn't open the link", link);
            })
          }
          className="self-start py-0.5 active:opacity-60"
        >
          <Text className="text-sm font-t3-medium text-primary-text" numberOfLines={1}>
            {link}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Long-running loops can log thousands of lines; the phone shows the end. */
const MAX_LOG_LINES = 200;

const LOG_LEVEL_CLASS: Partial<Record<AutomationRunLog["level"], string>> = {
  warn: "text-adaptive-amber-700-300",
  error: "text-adaptive-rose-600-400",
};

/** What the automation's code logged, folded away until someone wants to dig in. */
export function RunLogs(props: { readonly logs: ReadonlyArray<AutomationRunLog> }) {
  const [open, setOpen] = useState(false);
  const { logs } = props;
  if (logs.length === 0) return null;
  // Logs only grow, so a line's position in the whole log is a stable key.
  const first = Math.max(0, logs.length - MAX_LOG_LINES);
  const shown = logs.slice(first).map((log, offset) => ({ log, line: first + offset }));

  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Logs, ${logs.length} ${logs.length === 1 ? "line" : "lines"}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-9 flex-row items-center gap-2 self-start active:opacity-60"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="text-sm font-t3-medium text-foreground-muted">Logs</Text>
        <Text className="text-sm text-foreground-muted tabular-nums">{logs.length}</Text>
      </Pressable>
      {open ? (
        <View className="gap-0.5 rounded-2xl border border-border-subtle px-3 py-2">
          {shown.length < logs.length ? (
            <Text className="pb-1 text-xs text-foreground-muted">
              Showing the last {shown.length} of {logs.length}.
            </Text>
          ) : null}
          {shown.map(({ log, line }) => (
            <Text
              key={line}
              className={cn(
                "font-mono text-xs leading-normal",
                LOG_LEVEL_CLASS[log.level] ?? "text-foreground",
              )}
              selectable
            >
              {log.message}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
