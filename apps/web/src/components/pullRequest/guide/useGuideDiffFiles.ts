import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestDiffRevision, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";

import {
  isGuideDiffRevisionCurrent,
  samePullRequestDiffRevision,
} from "@t3tools/client-runtime/pull-request-diff-revision";
import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

interface LoadedDiff {
  readonly key: string;
  readonly cursor: string | null;
  readonly done: boolean;
  readonly files: ReadonlyMap<string, FileDiffMetadata>;
  readonly revision: PullRequestDiffRevision | undefined;
  readonly stale: boolean;
  readonly folded: unknown;
}

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

export function useGuideDiffFiles({
  environmentId,
  reference,
  headSha,
  wantedPaths,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  headSha: string;
  wantedPaths: ReadonlyArray<string>;
}) {
  const key = `${environmentId}:${pullRequestReviewKey(reference)}:${headSha}`;
  const [loaded, setLoaded] = useState<LoadedDiff>({
    key,
    cursor: null,
    done: false,
    files: NO_FILES,
    revision: undefined,
    stale: false,
    folded: null,
  });
  const current: LoadedDiff =
    loaded.key === key
      ? loaded
      : {
          key,
          cursor: null,
          done: false,
          files: NO_FILES,
          revision: undefined,
          stale: false,
          folded: null,
        };
  const missing = wantedPaths.some((path) => !current.files.has(path));
  const loading = missing && !current.done;
  const query = useEnvironmentQuery(
    loading
      ? pullRequestEnvironment.diff({
          environmentId,
          input: { ...reference, ...(current.cursor === null ? {} : { cursor: current.cursor }) },
        })
      : null,
  );

  // Each page is folded in once, during the render that first sees it.
  const data = query.data;
  if (data !== null && !current.done && current.folded !== data) {
    if (!isGuideDiffRevisionCurrent(headSha, data.revision)) {
      // The guide's excerpts belong to its head, so never pair them with another commit's diff.
      setLoaded({
        key,
        cursor: null,
        done: true,
        files: NO_FILES,
        revision: undefined,
        stale: true,
        folded: data,
      });
    } else {
      const parsed = getRenderablePatch(
        data.patch,
        `pull-request-guide:${key}:${current.cursor ?? "first"}`,
      );
      // The server can restart a stale continuation with a new first page; drop prior snapshot
      // files before following that response's next cursor.
      const files = samePullRequestDiffRevision(current.revision, data.revision)
        ? new Map(current.files)
        : new Map<string, FileDiffMetadata>();
      if (parsed?.kind === "files") {
        for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
      }
      setLoaded({
        key,
        cursor: data.nextCursor,
        done: data.nextCursor === null,
        files,
        revision: data.revision,
        stale: false,
        folded: data,
      });
    }
  }

  return {
    files: current.files,
    revision: current.revision,
    stale: current.stale,
    loading: loading && query.error === null,
    error: loading ? query.error : null,
    retry: query.refresh,
  };
}
