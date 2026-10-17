import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestDiffRevision, PullRequestRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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
}

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

function sameRevision(
  left: PullRequestDiffRevision | undefined,
  right: PullRequestDiffRevision | undefined,
): boolean {
  return left?.baseSha === right?.baseSha && left?.headSha === right?.headSha;
}

export function isGuideDiffRevisionCurrent(
  guideHeadSha: string,
  revision: PullRequestDiffRevision | undefined,
): boolean {
  return revision === undefined || revision.headSha.toLowerCase() === guideHeadSha.toLowerCase();
}

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

  const data = query.data;
  const cursor = current.cursor;
  useEffect(() => {
    if (data === null) return;
    setLoaded((previous) => {
      const base =
        previous.key === key
          ? previous
          : {
              key,
              cursor: null,
              done: false,
              files: NO_FILES,
              revision: undefined,
              stale: false,
            };
      if (base.cursor !== cursor || base.done) return base;
      if (!isGuideDiffRevisionCurrent(headSha, data.revision)) {
        // The guide's excerpts belong to its head, so never pair them with another commit's diff.
        return {
          key,
          cursor: null,
          done: true,
          files: NO_FILES,
          revision: undefined,
          stale: true,
        };
      }
      if (cursor !== null && !sameRevision(base.revision, data.revision)) {
        // A continuation from another snapshot has no place in this page chain. Start over.
        return {
          key,
          cursor: null,
          done: false,
          files: NO_FILES,
          revision: undefined,
          stale: false,
        };
      }
      const parsed = getRenderablePatch(
        data.patch,
        `pull-request-guide:${key}:${cursor ?? "first"}`,
      );
      const files = sameRevision(base.revision, data.revision)
        ? new Map(base.files)
        : new Map<string, FileDiffMetadata>();
      if (parsed?.kind === "files") {
        for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
      }
      return {
        key,
        cursor: data.nextCursor,
        done: data.nextCursor === null,
        files,
        revision: data.revision,
        stale: false,
      };
    });
  }, [cursor, data, headSha, key]);

  return {
    files: current.files,
    revision: current.revision,
    stale: current.stale,
    loading: loading && query.error === null,
    error: loading ? query.error : null,
    retry: query.refresh,
  };
}
