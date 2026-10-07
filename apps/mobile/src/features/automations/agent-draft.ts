import { NEW_AUTOMATION_PROMPT } from "@t3tools/client-runtime/automations/prompts";
import type { Automation, EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Alert } from "react-native";

import { useProjects } from "../../state/entities";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { newAutomationProject } from "./automation-list";

/** Opens a fresh new-task draft in `project` holding `prompt`. Says so when the project isn't here. */
export function useOpenAgentDraft() {
  const navigation = useNavigation();
  const projects = useProjects();
  return useCallback(
    async (project: ScopedProjectRef, prompt: string) => {
      const loaded = projects.some(
        (candidate) =>
          candidate.environmentId === project.environmentId && candidate.id === project.projectId,
      );
      if (!loaded) {
        Alert.alert("Couldn't open a thread", "The automation's project isn't available here.");
        return;
      }
      // The draft screen only opens a draft id once persisted drafts have loaded.
      await waitForComposerDraftsLoaded().catch(() => undefined);
      const draftKey = createNewTaskDraft(project);
      setComposerDraftText(draftKey, prompt);
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.projectId),
          draftId: draftKey,
        },
      });
    },
    [navigation, projects],
  );
}

/** Opens "Create an automation that " in the likeliest project; null when there's no project. */
export function useNewAutomationDraft(
  automations: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly automation: Automation;
  }>,
  environmentIds: ReadonlySet<EnvironmentId>,
): (() => void) | null {
  const projects = useProjects();
  const openDraft = useOpenAgentDraft();
  const project = newAutomationProject(automations, projects, environmentIds);
  return project ? () => void openDraft(project, NEW_AUTOMATION_PROMPT) : null;
}
