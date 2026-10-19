import { AutomationError, ThreadId } from "@t3tools/contracts";
import type {
  DeploymentEvidence,
  DeploymentEvidenceInput,
} from "@t3tools/contracts/deploymentEvidence";
import { AutomationThreads } from "@signalbox/automations/host";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { GitHub } from "../github/GitHub.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import { makeDeploymentReads } from "../github/deploymentReads.ts";

/** The RPC and automation step read the same host evidence, with the same thread access. */
export class DeploymentEvidenceReader extends Context.Service<
  DeploymentEvidenceReader,
  {
    readonly read: (
      input: DeploymentEvidenceInput,
    ) => Effect.Effect<DeploymentEvidence, AutomationError>;
  }
>()("@signalbox/cloud/automations/deploymentEvidence/DeploymentEvidenceReader") {}

const makeDeploymentEvidence = Effect.gen(function* () {
  const threads = yield* AutomationThreads;
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const reads = makeDeploymentReads(github.api);

  return Effect.fn("DeploymentEvidenceReader.read")(function* (input: DeploymentEvidenceInput) {
    const target = parseChangeRequestUrl(input.url);
    const shell = yield* threads.getThreadShell(ThreadId.make(input.threadId));
    const linked =
      target === null || shell === null || shell.deletedAt !== null
        ? undefined
        : visibleThreadPullRequests(shell.pullRequests ?? []).find((link) =>
            threadPullRequestKeysEqual(link, target),
          );
    if (!linked)
      return yield* new AutomationError({
        message: "Read deployment evidence for a pull request linked to an accessible thread.",
      });
    if (linked.host.toLowerCase() !== github.api.host)
      return yield* new AutomationError({
        message: "Deployment evidence is available for this environment's GitHub host only.",
      });
    const token = yield* connection.accessToken.pipe(
      Effect.mapError(
        (cause) => new AutomationError({ message: "Couldn't read your GitHub connection.", cause }),
      ),
    );
    if (token === null)
      return yield* new AutomationError({ message: "Connect GitHub to read deployment evidence." });
    return yield* reads.read(token, linked.repository, linked.number, input.runId).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({
            message: `Couldn't verify the deployment: ${cause.message}`,
            cause,
          }),
      ),
    );
  });
});

export const layer = Layer.effect(
  DeploymentEvidenceReader,
  Effect.map(makeDeploymentEvidence, (read) => DeploymentEvidenceReader.of({ read })),
);
