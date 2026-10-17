import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import {
  useUndoFailure,
  useUndoLastTurnTarget,
  type UndoLastTurnTarget,
} from "../../state/undo-last-turn";

const UNDO_TITLE = "Undo last turn?";
const UNDO_MESSAGE = "This removes your last message and the agent's reply.";

/** Shows only on the user message that started the thread's last undoable turn. */
export function UndoLastTurnButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly tintColor: ColorValue;
}) {
  const target = useUndoLastTurnTarget(props.environmentId, props.threadId);
  if (target === null || target.userMessageId !== props.messageId) return null;
  return <UndoLastTurnControl {...props} target={target} />;
}

function UndoLastTurnControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tintColor: ColorValue;
  readonly target: UndoLastTurnTarget;
}) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const providers = useRemoteEnvironmentRuntime(props.environmentId)?.serverConfig?.providers;
  const revertCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, "undo last turn");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<CommandId | null>(null);
  const reportedFailure = useRef<CommandId | null>(null);
  const failure = useUndoFailure(props.environmentId, props.threadId, requestId);
  const reportFailure = useCallback((id: CommandId, message: string) => {
    if (reportedFailure.current === id) return;
    reportedFailure.current = id;
    Dialog.alert("Couldn't undo", message);
  }, []);
  useEffect(() => {
    if (requestId !== null && failure !== null) reportFailure(requestId, failure);
  }, [failure, reportFailure, requestId]);
  const provider = providers?.find(
    (candidate) => candidate.instanceId === props.target.providerInstanceId,
  );
  if (!canOperate || provider?.supportsConversationRollback === false) {
    return null;
  }

  const undo = (restoreFiles: boolean) => {
    const commandId = CommandId.make(uuidv4());
    setRequestId(commandId);
    setBusy(true);
    void Haptics.selectionAsync();
    void revertCheckpoint({
      environmentId: props.environmentId,
      input: {
        commandId,
        threadId: props.threadId,
        scopeId: props.target.scopeId,
        checkpointId: props.target.checkpointId,
        restoreFiles,
      },
    })
      .then((result) => {
        if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
          reportFailure(commandId, String(squashAtomCommandFailure(result)));
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Undo last turn"
      hitSlop={8}
      disabled={busy}
      className="size-7 items-center justify-center disabled:opacity-40"
      onPress={() => {
        if (!props.target.changedFiles) {
          Dialog.confirm({
            title: UNDO_TITLE,
            message: UNDO_MESSAGE,
            confirmText: "Undo",
            destructive: true,
            onConfirm: () => undo(false),
          });
          return;
        }
        Dialog.alert(UNDO_TITLE, `${UNDO_MESSAGE} Keep the files it changed, or undo them too.`, [
          { text: "Cancel", style: "cancel" },
          { text: "Keep file changes", onPress: () => undo(false) },
          { text: "Undo files too", style: "destructive", onPress: () => undo(true) },
        ]);
      }}
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView name="arrow.uturn.backward" size={14} tintColor={props.tintColor} />
      )}
    </Pressable>
  );
}
