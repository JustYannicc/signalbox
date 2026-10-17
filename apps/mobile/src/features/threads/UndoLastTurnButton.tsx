import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useUndoLastTurnTarget, type UndoLastTurnTarget } from "../../state/undo-last-turn";

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
  const provider = providers?.find(
    (candidate) => candidate.instanceId === props.target.providerInstanceId,
  );
  if (!canOperate || provider === undefined || provider.supportsConversationRollback === false) {
    return null;
  }

  const undo = (restoreFiles: boolean) => {
    setBusy(true);
    void Haptics.selectionAsync();
    void revertCheckpoint({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        scopeId: props.target.scopeId,
        checkpointId: props.target.checkpointId,
        restoreFiles,
      },
    }).finally(() => setBusy(false));
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
