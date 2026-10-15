// signalbox: while the thread list shows a folder, New task skips choosing a project.
import { StackActions, useIsFocused, useNavigation } from "@react-navigation/native";
import { useEffect, useRef } from "react";

import { useProjects } from "../../state/entities";
import { useNewTaskFlow } from "../threads/new-task-flow-provider";

/**
 * Opens the draft in the shown folder's project, once per folder. Back from
 * that draft, or opened from a draft to choose another project, the picker
 * stays. A share or prompt link (`routeParams`) keeps the picker's own flow.
 */
export function useFolderStartRedirect(routeParams: object | undefined) {
  const folderStart = useNewTaskFlow().folders.start;
  const projects = useProjects();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const project = folderStart
    ? projects.find(
        (candidate) =>
          candidate.environmentId === folderStart.environmentId &&
          candidate.id === folderStart.projectId,
      )
    : undefined;
  const startKey = folderStart
    ? `${folderStart.environmentId}:${folderStart.folderId ?? "top"}:${folderStart.projectId}`
    : null;
  // The start this screen already handled; a different folder is handled anew.
  const handledRef = useRef<string | null>(null);
  const plain = routeParams === undefined || Object.keys(routeParams).length === 0;
  useEffect(() => {
    if (!isFocused || !plain || startKey === null || project === undefined) return;
    if (handledRef.current === startKey) return;
    handledRef.current = startKey;
    const state = navigation.getState();
    if (state?.routes[state.index - 1]?.name === "NewTaskDraft") return;
    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
      }),
    );
  }, [isFocused, navigation, plain, project, startKey]);
}
