// signalbox: the thread header's Find button (#792). Hidden where the server can't search a thread.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useMemo } from "react";
import { Keyboard } from "react-native";

import type { AppBarAction } from "../../../components/ui/AppBar.types";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { withNativeGlassHeaderItem } from "../../layout/native-glass-header-items";
import { requestThreadFindAt } from "./thread-find-request";

const isEnvironmentId = Schema.is(EnvironmentId);
const isThreadId = Schema.is(ThreadId);

/** The thread's key when its server can search it; null otherwise. */
function useFindableThreadKey(environmentId: unknown, threadId: unknown): string | null {
  const environment = isEnvironmentId(environmentId) ? environmentId : null;
  const findable = useEnvironmentServerConfig(environment)?.threadFind === true;
  return findable && environment !== null && isThreadId(threadId)
    ? scopedThreadKey(environment, threadId)
    : null;
}

function openFind(threadKey: string) {
  Keyboard.dismiss();
  requestThreadFindAt({ threadKey, query: "" });
}

export function useThreadFindAppBarActions(
  environmentId: unknown,
  threadId: unknown,
): ReadonlyArray<AppBarAction> {
  const threadKey = useFindableThreadKey(environmentId, threadId);
  return useMemo(
    () =>
      threadKey === null
        ? []
        : [
            {
              accessibilityLabel: "Find in thread",
              icon: "magnifyingglass" as const,
              onPress: () => openFind(threadKey),
            },
          ],
    [threadKey],
  );
}

export function useThreadFindNativeHeaderItems(
  environmentId: unknown,
  threadId: unknown,
): ReadonlyArray<Record<string, unknown>> {
  const threadKey = useFindableThreadKey(environmentId, threadId);
  return useMemo(
    () =>
      threadKey === null
        ? []
        : [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Find in thread",
              icon: { name: "magnifyingglass", type: "sfSymbol" as const },
              identifier: "thread-right-find",
              label: "Find in thread",
              onPress: () => openFind(threadKey),
              type: "button" as const,
            }),
          ],
    [threadKey],
  );
}
