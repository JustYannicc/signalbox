import * as Crypto from "effect/Crypto";

import type { GitHubApi } from "./GitHubApi.ts";
import type { GitHubOperationJournal } from "./githubOperationJournal.ts";
import { MAX_ARTIFACT_ARCHIVE_BYTES, MAX_ARTIFACT_ENTRY_BYTES } from "./workflow/artifactZip.ts";
import { makeWorkflowArtifact } from "./workflow/artifact.ts";
import { makeWorkflowDispatch } from "./workflow/dispatch.ts";
import { makeCreateIssue } from "./workflow/issues.ts";

export { MAX_ARTIFACT_ARCHIVE_BYTES, MAX_ARTIFACT_ENTRY_BYTES };

export const makeWorkflowApi = (
  api: GitHubApi,
  journal: GitHubOperationJournal,
  crypto: Crypto.Crypto,
) => ({
  ...makeWorkflowDispatch(api, journal),
  workflowArtifact: makeWorkflowArtifact(api, crypto),
  createIssue: makeCreateIssue(api, journal),
});
