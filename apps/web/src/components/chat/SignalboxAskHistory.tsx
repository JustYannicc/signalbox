import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";

const kindLabels = { blocker: "Blocker", ready: "Ready", considering: "Considering" };

function answerText(value: SignalboxAsk["questions"][number]["recommendation"]) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function SignalboxAskHistory({ asks }: { asks: ReadonlyArray<SignalboxAsk> }) {
  if (asks.length === 0) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer px-3 py-2 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary">
        Ask history ({asks.length})
      </summary>
      <div className="divide-y divide-border border-t border-border">
        {asks.map((ask) => (
          <article key={ask.id} className="space-y-3 p-3 wrap-anywhere">
            <h3 className="font-medium text-foreground">
              {kindLabels[ask.kind]} ·{" "}
              {ask.status === "answered"
                ? "Answered"
                : ask.status === "withdrawn"
                  ? "Withdrawn"
                  : "Archived"}
            </h3>
            {ask.rounds.map((round) => (
              <section key={round.number} className="space-y-2">
                <h4 className="font-medium">Round {round.number}</h4>
                {round.questionIds.map((questionId) => {
                  const question = ask.questions.find((entry) => entry.id === questionId);
                  const answer = round.answers.find((entry) => entry.questionId === questionId);
                  const deferred = round.deferredQuestionIds.includes(questionId);
                  return (
                    <div key={questionId} className="space-y-1">
                      <p className="text-foreground">
                        {question?.question ?? "Question no longer available"}
                      </p>
                      {answer ? (
                        <>
                          <p>
                            <span className="font-medium">Answer: </span>
                            {answerText(answer.value)}
                          </p>
                          <p>
                            {answer.answeredBy.kind === "assistant"
                              ? "Assistant for"
                              : "Answered by"}{" "}
                            {answer.answeredBy.personId} · Recommendation{" "}
                            {answer.recommendationTaken ? "taken" : "overridden"}
                          </p>
                          {answer.comment ? <p>Answer comment: {answer.comment}</p> : null}
                        </>
                      ) : (
                        <p>{deferred ? "Deferred" : "Not answered"}</p>
                      )}
                    </div>
                  );
                })}
                {round.comment ? <p>Round comment: {round.comment}</p> : null}
              </section>
            ))}
          </article>
        ))}
      </div>
    </details>
  );
}
