// signalbox: opens a thread by id from outside the thread list: a linked PR thread, a note turned task.
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { Platform } from "react-native";

import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

export function useOpenThread() {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  return useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      const destination = { environmentId, threadId };
      if (Platform.OS === "android")
        selectAndroidWorkspace({ name: "Thread", params: destination });
      else navigation.navigate("Thread", destination);
    },
    [navigation, selectAndroidWorkspace],
  );
}
