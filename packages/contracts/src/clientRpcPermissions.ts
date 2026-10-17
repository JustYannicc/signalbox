import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import { SIGNALBOX_DRIVES_WS_METHODS } from "./signalboxDrives.ts"; // signalbox: drives
import { SIGNALBOX_FOLDERS_WS_METHODS } from "./signalboxFolders.ts"; // signalbox: folders
import { SIGNALBOX_NOTES_WS_METHODS } from "./signalboxNotes.ts"; // signalbox: notes
import { SIGNALBOX_SIGN_IN_WS_METHODS } from "./signalboxSignIn.ts"; // signalbox: sign-in grants
import { SIGNALBOX_BROWSING_WS_METHODS } from "./signalboxBrowsing.ts"; // signalbox: browsing
import {
  SIGNALBOX_AGENT_BROWSER_WS_METHODS,
  SIGNALBOX_PREVIEWS_WS_METHODS,
} from "./signalboxPreviews.ts"; // signalbox: previews
import { SIGNALBOX_THREAD_KINDS_WS_METHODS } from "./signalboxThreadKinds.ts"; // signalbox: thread kinds
import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "./signalboxPersonBrowser.ts";
import { PERSON_TIMEZONE_WS_METHODS } from "./personTimezone.ts";
import { SIGNALBOX_ANALYTICS_WS_METHODS } from "./signalboxAnalytics.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled]: AuthSettingsWriteScope,
  [PERSON_TIMEZONE_WS_METHODS.set]: AuthSettingsWriteScope,
  [PERSON_TIMEZONE_WS_METHODS.report]: AuthSettingsWriteScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [SIGNALBOX_DRIVES_WS_METHODS.create]: AuthOrchestrationOperateScope, // signalbox: drives
  [SIGNALBOX_DRIVES_WS_METHODS.share]: AuthOrchestrationOperateScope, // signalbox: drives
  [SIGNALBOX_DRIVES_WS_METHODS.unshare]: AuthOrchestrationOperateScope, // signalbox: drives
  [SIGNALBOX_DRIVES_WS_METHODS.shareFolder]: AuthOrchestrationOperateScope, // signalbox: drives
  [SIGNALBOX_DRIVES_WS_METHODS.addShortcut]: AuthOrchestrationOperateScope, // signalbox: drives
  [SIGNALBOX_DRIVES_WS_METHODS.removeShortcut]: AuthOrchestrationOperateScope, // signalbox: drives
  [SIGNALBOX_PREVIEWS_WS_METHODS.open]: AuthOrchestrationOperateScope, // signalbox: previews
  [SIGNALBOX_BROWSING_WS_METHODS.dispatch]: AuthPreviewOperateScope, // signalbox: browsing
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.input]: AuthOrchestrationOperateScope, // signalbox: agent browser
  [SIGNALBOX_FOLDERS_WS_METHODS.create]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.update]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.move]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.delete]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.moveThread]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.setInstructions]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.setPhase]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]: AuthOrchestrationOperateScope, // signalbox: thread kinds
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays]: AuthSettingsWriteScope, // signalbox: thread kinds
  [SIGNALBOX_FOLDERS_WS_METHODS.setSecrets]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.setOnePassword]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_FOLDERS_WS_METHODS.setGitHubLend]: AuthOrchestrationOperateScope, // signalbox: folders
  [SIGNALBOX_NOTES_WS_METHODS.create]: AuthOrchestrationOperateScope, // signalbox: notes
  [SIGNALBOX_NOTES_WS_METHODS.update]: AuthOrchestrationOperateScope, // signalbox: notes
  [SIGNALBOX_NOTES_WS_METHODS.delete]: AuthOrchestrationOperateScope, // signalbox: notes
  [SIGNALBOX_NOTES_WS_METHODS.readAgain]: AuthOrchestrationOperateScope, // signalbox: notes
  [SIGNALBOX_NOTES_WS_METHODS.dismissReading]: AuthOrchestrationOperateScope, // signalbox: notes
  [SIGNALBOX_NOTES_WS_METHODS.accept]: AuthOrchestrationOperateScope, // signalbox: notes
  [SIGNALBOX_SIGN_IN_WS_METHODS.grant]: AuthSettingsWriteScope, // signalbox: sign-in grants
  [SIGNALBOX_SIGN_IN_WS_METHODS.revoke]: AuthSettingsWriteScope, // signalbox: sign-in grants
  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]: AuthPreviewOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
