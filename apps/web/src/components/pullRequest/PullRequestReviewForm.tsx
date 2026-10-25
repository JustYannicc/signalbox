import { useAtomRefresh } from "@effect/atom-react";
import { useAtomCommand } from "~/state/use-atom-command";
import { preparePullRequestWriteAttempt } from "@t3tools/client-runtime/pull-request-write-attempt";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PullRequestOperationError,
  type EnvironmentId,
  type PullRequestRef,
  type PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState, type ReactNode, type RefObject } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  pendingReviewCommentsHaveStaleHead,
  pullRequestReviewKey,
  pullRequestWriteAttemptKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

const VERDICTS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
  readonly sent: string;
  readonly icon: ReactNode;
}> = [
  {
    value: "comment",
    label: "Comment",
    sent: "Review submitted",
    icon: <MessageSquareIcon className="size-3" />,
  },
  {
    value: "approve",
    label: "Approve",
    sent: "Pull request approved",
    icon: <CheckIcon className="size-3" />,
  },
  {
    value: "request-changes",
    label: "Request changes",
    sent: "Changes requested",
    icon: <XCircleIcon className="size-3" />,
  },
];

const isPullRequestOperationError = Schema.is(PullRequestOperationError);

export function PullRequestReviewForm({
  environmentId,
  reference,
  reviewedHeadSha,
  currentHeadSha,
  headStatus,
  verdicts,
  requestChangesSummaryRequired,
  textareaRef,
  pending,
  onPendingChange,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  reviewedHeadSha: string | undefined;
  currentHeadSha: string | undefined;
  headStatus: "loading" | "failed" | "pinned" | undefined;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSubmitted: () => void;
}) {
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const comments = usePendingReviewComments(reference);
  const commentsHaveStaleHead = pendingReviewCommentsHaveStaleHead(comments, reviewedHeadSha);
  const reviewKey = pullRequestReviewKey(reference);
  // The panel stays mounted while the selected pull request changes. Keeping summaries beside
  // the keyed line-comment drafts makes the selected pull request's body correct on the first
  // render, before an effect could reset state left behind by the previous one.
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const refreshDetail = useAtomRefresh(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const attemptKey = pullRequestWriteAttemptKey(reference, "review", environmentId);
  // Only a known newer head blocks the pin; hosts also report same-head rejections as conflicts.
  const headMoved =
    reviewedHeadSha !== undefined &&
    currentHeadSha !== undefined &&
    currentHeadSha !== reviewedHeadSha;

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  const selectedVerdict =
    offered.find((verdict) => verdict.value === requestedVerdict) ?? offered[0];

  const submit = async (verdict: (typeof VERDICTS)[number]) => {
    if (pending) return;
    const submittedBody = body;
    const submittedCommentIds = comments.map((comment) => comment.id);
    const submittedComments = comments.map(({ id: _id, headSha: _headSha, ...comment }) => comment);
    const prepared = preparePullRequestWriteAttempt(
      usePullRequestReviewStore.getState().writeAttempts[attemptKey],
      {
        ...reference,
        verdict: verdict.value,
        body: submittedBody,
        comments: submittedComments,
      },
      reviewedHeadSha,
      randomUUID,
      environmentId,
    );
    usePullRequestReviewStore.getState().setWriteAttempt(attemptKey, prepared.attempt);
    onPendingChange(true);
    const result = await submitReview({
      environmentId,
      input: prepared.input,
    });
    onPendingChange(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      if (isPullRequestOperationError(failure) && failure.reason === "conflict") {
        // Reveals a real head move below; the pin changes only on the next review entry.
        refreshDetail();
        toastManager.add({
          type: "error",
          title: "The provider rejected this review",
          description: "Your summary and comments are kept.",
        });
        return;
      }
      toastManager.add({ type: "error", title: "The review could not be submitted" });
      return;
    }
    usePullRequestReviewStore
      .getState()
      .clearWriteAttempt(attemptKey, prepared.attempt.operationId);
    // More remarks may have been added while the host was accepting this snapshot. Leave those,
    // and any summary revised in the meantime, ready for the next review.
    removeComments(reviewKey, submittedCommentIds);
    clearSummary(reviewKey, submittedBody);
    toastManager.add({ type: "success", title: verdict.sent });
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmit = (verdict: PullRequestReviewVerdict, summary: string) =>
    reviewedHeadSha !== undefined &&
    !headMoved &&
    !commentsHaveStaleHead &&
    (verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" || summary.trim().length > 0 || comments.length > 0);
  const placeholder =
    selectedVerdict === undefined || canSubmit(selectedVerdict.value, "")
      ? "Summarize your review (optional)"
      : selectedVerdict.value === "request-changes" && requestChangesSummaryRequired
        ? "Summarize your review (required to request changes)"
        : "Summarize your review or add line comments";

  return (
    <>
      <Textarea
        ref={textareaRef}
        rows={3}
        value={body}
        placeholder={placeholder}
        aria-label="Review summary"
        onChange={(event) => setSummary(reviewKey, event.target.value)}
      />
      {headStatus === "loading" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Checking this pull request&apos;s current version…
        </p>
      ) : headStatus === "failed" ? (
        <p className="mt-2 text-xs text-destructive">
          Couldn&apos;t load this pull request&apos;s current version. Close and reopen the review
          to try again.
        </p>
      ) : headStatus === "pinned" && reviewedHeadSha === undefined ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The provider didn&apos;t say which version of this pull request is current, so this review
          can&apos;t be submitted.
        </p>
      ) : headMoved ? (
        <p className="mt-2 text-xs text-destructive">
          This pull request changed since you opened the review. Close and reopen it to review the
          new version. Your summary and comments are kept.
        </p>
      ) : commentsHaveStaleHead ? (
        <p className="mt-2 text-xs text-destructive">
          Some comments are on a different version than this review. Reopen the review to use the
          latest version, or remove those comments.
        </p>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        {offered.length > 1 ? (
          <Select
            value={selectedVerdict?.value ?? null}
            disabled={pending}
            onValueChange={(value) => {
              if (value !== null) setRequestedVerdict(value);
            }}
          >
            <SelectTrigger size="xs" className="mr-auto w-auto min-w-0" aria-label="Review verdict">
              <span className="flex items-center gap-1.5">
                {selectedVerdict?.icon}
                {selectedVerdict?.label}
              </span>
            </SelectTrigger>
            <SelectPopup side="top" alignItemWithTrigger={false}>
              {offered.map((verdict) => (
                <SelectItem key={verdict.value} value={verdict.value}>
                  <span className="flex items-center gap-1.5">
                    {verdict.icon}
                    {verdict.label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Button
          size="xs"
          disabled={
            pending || selectedVerdict === undefined || !canSubmit(selectedVerdict.value, body)
          }
          onClick={() => {
            if (selectedVerdict !== undefined) void submit(selectedVerdict);
          }}
        >
          {pending ? "Submitting..." : "Submit review"}
        </Button>
      </div>
    </>
  );
}
