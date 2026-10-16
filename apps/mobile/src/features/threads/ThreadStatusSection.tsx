// signalbox: a thread's status line (#670) at the top of Thread settings.
import {
  threadStatusHeadline,
  threadStatusLine,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { useThreadShell } from "../../state/entities";
import {
  useEnvironmentHasStatusNotes,
  useThreadStatusNote,
} from "../../state/signalboxThreadStatus";

function updatedLabel(writtenAt: DateTime.Utc): string {
  const age = relativeTime(DateTime.formatIso(writtenAt));
  return age === "<1m" ? "Updated just now" : `Updated ${age} ago`;
}

/**
 * What's going on and what happens next, the same line everyone with access
 * sees: the state as code reads it, then the agent's next step and where it
 * got to. Renders nothing where the environment keeps no notes.
 */
export function ThreadStatusSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const supported = useEnvironmentHasStatusNotes(props.environmentId);
  const shell = useThreadShell(
    supported ? { environmentId: props.environmentId, threadId: props.threadId } : null,
  );
  const note = useThreadStatusNote(props.environmentId, props.threadId);
  if (!supported || shell === null) return null;
  const line = threadStatusLine(shell.source, note);
  return (
    <View className="pb-3">
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Status</Text>
      <View className="mx-4 gap-1.5 rounded-2xl bg-grouped-card px-4 py-3">
        <Text className="text-sm font-t3-medium text-foreground">{threadStatusHeadline(line)}</Text>
        {line.note ? (
          <>
            <Text className="text-sm text-foreground">
              <Text className="text-sm font-t3-medium text-foreground-muted">Next: </Text>
              {line.note.nextStep}
            </Text>
            <Text className="text-sm text-foreground-muted">{line.note.whereItGotTo}</Text>
            <Text className="pt-0.5 text-xs text-foreground-muted">
              {updatedLabel(line.note.writtenAt)}
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}
