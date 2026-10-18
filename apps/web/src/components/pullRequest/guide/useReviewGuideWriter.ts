import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import {
  preparePullRequestWriteAttempt,
  type PullRequestWriteAttemptRecord,
} from "@t3tools/client-runtime/pull-request-write-attempt";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../../ui/toast";
import { randomUUID } from "~/lib/utils";
import { readableFailure } from "../pullRequestDetail.logic";
import { guideRunKey, useGuideRunStore } from "./guideRunStore";

export function useReviewGuideWriter({
  environmentId,
  reference,
  title,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  title: string | null;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.reviewGuide({ environmentId, input: reference }),
  );
  const canWrite = useAtomValue(
    pullRequestEnvironment.generateReviewGuide.permissionAtom(environmentId),
  );
  const generate = useAtomCommand(pullRequestEnvironment.generateReviewGuide, {
    reportFailure: false,
  });
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  const attempt = useRef<PullRequestWriteAttemptRecord | undefined>(undefined);
  const data = query.data;
  const running = starting || data?.run?._tag === "Running";

  const watchRun = useEffectEvent(() =>
    useGuideRunStore.getState().watch({
      environmentId,
      reference,
      title,
      previousGuideAt: data?.guide?.generatedAt ?? null,
      previousFailedAt: data?.run?._tag === "Failed" ? data.run.failedAt : null,
      since: Date.now(),
    }),
  );
  useEffect(() => {
    if (data?.run?._tag === "Running") watchRun();
  }, [data?.run?._tag]);

  const reportFailure = (cause: unknown) => {
    useGuideRunStore.getState().settle(guideRunKey(environmentId, reference));
    toastManager.add({
      type: "error",
      title: "Could not start a review guide",
      description: readableFailure(
        cause,
        "Check the review guide model in Settings → Source Control.",
      ),
    });
  };

  const write = async () => {
    if (running || pending.current) return;
    pending.current = true;
    setStarting(true);
    watchRun();
    try {
      const prepared = preparePullRequestWriteAttempt(
        attempt.current,
        reference,
        data?.currentHeadSha ?? undefined,
        randomUUID,
        environmentId,
      );
      attempt.current = prepared.attempt;
      const result = await generate({ environmentId, input: prepared.input });
      pending.current = false;
      setStarting(false);
      if (result._tag === "Success") attempt.current = undefined;
      if (result._tag === "Failure") {
        reportFailure(squashAtomCommandFailure(result));
      }
    } catch (cause) {
      pending.current = false;
      setStarting(false);
      reportFailure(cause);
    }
  };

  return { query, data, running, canWrite, write };
}
