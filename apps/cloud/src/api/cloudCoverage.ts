import type { Operation } from "@signalbox/api/catalog";

import { CLOUD_COMMANDS } from "../thread/threadDecider.ts";
import { CloudRpcGroup } from "../user/rpc.ts";

/**
 * Which public API operations the cloud serves. Every operation is either
 * served (its RPC is in `CloudRpcGroup` and, for commands, `decide` takes it)
 * or listed below: a gap names the issue that closes it, an exemption says why
 * the cloud never serves it. `cloudCoverage.test.ts` fails on anything else,
 * so a new RPC lands here as a decision, not as a silent 404.
 */

export type Unserved =
  | { readonly _tag: "gap"; readonly issue: `#${number}` }
  | { readonly _tag: "exempt"; readonly reason: string };

const gap = (issue: `#${number}`): Unserved => ({ _tag: "gap", issue });
const exempt = (reason: string): Unserved => ({ _tag: "exempt", reason });

/** Threads run on machines nobody operates (#401), so nothing addresses a host. */
const noHost = exempt(
  "Addresses the host a server runs on; cloud threads run on machines nobody operates.",
);
const replacedByAutomations = exempt("Scheduled tasks are going away; automations replace them.");
const ownBranch = exempt("Each cloud thread works on its own branch.");
const githubImports = exempt("Repositories import from GitHub (`github/GitHubImport.ts`).");
const selfDeploying = exempt("The cloud deploys itself; nobody updates it from a client.");
const poolHarnesses = exempt("Pools run each harness; nothing installs per user.");

/** Keys are operation names, or `prefix.*` for every operation under a prefix. */
export const CLOUD_UNSERVED: Readonly<Record<string, Unserved>> = {
  "settings.get": gap("#440"),

  // Waiting on you: approvals, questions and secret requests.
  "threads.respond": gap("#410"),
  "threads.dismissQuestion": gap("#410"),
  "secrets.answer": gap("#410"),

  // The rest of a thread's lifecycle.
  "threads.delete": gap("#439"),
  "threads.snooze": gap("#439"),
  "threads.unsnooze": gap("#439"),
  "threads.active.reorder": gap("#439"),
  "threads.markUnread": gap("#439"),
  "threads.fork": gap("#439"),
  "threads.mergeBack": gap("#439"),
  "threads.queuedRun.edit": gap("#439"),
  "threads.queuedRun.reorder": gap("#439"),
  "threads.switchProvider": gap("#439"),
  "threads.stopSubagent": gap("#439"),
  "threads.commandOutput": gap("#439"),
  "threads.getTurnItem": gap("#439"),
  "threads.getWorkflowScript": gap("#439"),
  "threads.stopWorkflow": gap("#439"),
  "threads.rollback": gap("#398"),
  "threads.search": gap("#334"),
  "threads.searchOne": gap("#334"),

  // Pull-request reads are served by `github/CloudPullRequests.ts` (#814).
  // The later slices own writes and personal review state.
  "pullRequests.reviewGuide": gap("#815"),
  "pullRequests.generateReviewGuide": gap("#815"),
  "pullRequests.filesViewed": gap("#815"),
  "pullRequests.setFilesViewed": gap("#815"),
  "pullRequests.comment": gap("#816"),
  "pullRequests.updateComment": gap("#816"),
  "pullRequests.submitReview": gap("#816"),
  "pullRequests.replyToThread": gap("#816"),
  "pullRequests.setThreadResolution": gap("#816"),
  "pullRequests.setReaction": gap("#816"),
  "pullRequests.runAction": gap("#817"),
  "pullRequests.update": gap("#817"),
  "pullRequests.reviewerCandidates": gap("#817"),
  "pullRequests.requestReviewers": gap("#817"),
  "pullRequests.labelCandidates": gap("#817"),
  "pullRequests.setLabels": gap("#817"),
  "threads.pullRequest.watch": gap("#818"),
  "git.preparePullRequestThread": gap("#818"),

  // Git beyond the thread's own branch.
  "sourceControl.cloneRepository": githubImports,
  "sourceControl.publishRepository": gap("#810"),

  // Files in folders without a machine.
  "projects.writeFile": gap("#439"),
  "projects.searchContents": gap("#439"),
  "projects.createNew": exempt("Folders hold projects; create one with folders.create."),
  "projects.mutate": exempt("Folders hold projects; change them with folders.*."),
  "assets.persistChatAttachments": gap("#813"),

  // Pools: the cloud signs in Claude and ChatGPT accounts only.
  "pools.advice": gap("#819"),
  "provider.auth.respond": gap("#205"),
  "provider.auth.logout": gap("#205"),
  "provider.chatgpt.*": exempt("A self-hosted server's ChatGPT desktop handoff."),
  "provider.codex.authCallback.subscribe": exempt(
    "A self-hosted server's localhost sign-in callback.",
  ),
  "provider.consumeResetCredit": gap("#820"),
  "provider.install.*": poolHarnesses,
  "provider.uploadFeedback": gap("#822"),
  "server.updateProvider": poolHarnesses,

  "acpRegistry.*": exempt("ACP agents install on a host; cloud threads run on pool harnesses."),
  "agentSessions.*": exempt("Imports sessions from CLIs on the host."),
  "authAccess.subscribe": exempt("Pairing links and client sessions are not served (#401)."),
  "backgroundPolicy.subscribe": noHost,
  "device.*": noHost,
  "deviceState.subscribe": noHost,
  "diagnostics.*": noHost,
  "discoveredLocalServers.subscribe": noHost,
  "filesystem.*": noHost,
  "relay.*": exempt("The relay connects self-hosted servers to the cloud."),
  "resourceTelemetry.subscribe": noHost,
  "scheduledTasks.*": replacedByAutomations,
  "server.backgroundPolicy": noHost,
  "server.commitDesktopUpdate": noHost,
  "server.updateServer": selfDeploying,
  "server.updateServerWithProgress": selfDeploying,
  "storage.*": noHost,
  "terminal.*": gap("#744"),
  "terminalEvents.subscribe": gap("#744"),
  "terminalMetadata.subscribe": gap("#744"),
  "usage.*": gap("#786"),
  "vcs.createRef": ownBranch,
  "vcs.switchRef": ownBranch,
  "vcs.createWorktree": ownBranch,
  "vcs.removeWorktree": ownBranch,
  "vcs.init": githubImports,
};

/** Whether `name` falls under `key`, an operation name or a `prefix.*`. */
export const coverageKeyMatches = (key: string, name: string): boolean =>
  key.endsWith(".*") ? name.startsWith(key.slice(0, -1)) : key === name;

const servedRpcs: ReadonlySet<string> = new Set(CloudRpcGroup.requests.keys());

/** Whether the cloud answers `operation` today. */
export const cloudServes = (operation: Operation): boolean =>
  servedRpcs.has(operation.rpc) &&
  (operation.command === undefined || CLOUD_COMMANDS.has(operation.command));

/** Why the cloud doesn't answer `operation`, or undefined when it does or nobody said. */
export const cloudUnserved = (operation: Operation): Unserved | undefined => {
  const key = Object.keys(CLOUD_UNSERVED).find((candidate) =>
    coverageKeyMatches(candidate, operation.name),
  );
  return key === undefined ? undefined : CLOUD_UNSERVED[key];
};
