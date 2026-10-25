import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

const kindLabels = { blocker: "Blocker", ready: "Ready", considering: "Considering" };

function answerText(value: SignalboxAsk["questions"][number]["recommendation"]) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function SignalboxAskHistory({ asks }: { readonly asks: ReadonlyArray<SignalboxAsk> }) {
  const [expanded, setExpanded] = useState(false);
  if (asks.length === 0) return null;
  return (
    <View className="border-t border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Hide" : "Show"} ask history, ${asks.length} closed asks`}
        accessibilityState={{ expanded }}
        className="flex-row items-center justify-between px-4 py-3"
        hitSlop={8}
        onPress={() => setExpanded((current) => !current)}
      >
        <Text className="font-t3-bold text-sm text-foreground">Ask history ({asks.length})</Text>
        <Text className="font-sans text-sm text-foreground-muted">
          {expanded ? "Hide" : "Show"}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="divide-y divide-border">
          {asks.map((ask) => (
            <View key={ask.id} className="gap-3 p-4">
              <Text className="font-t3-bold text-sm text-foreground">
                {kindLabels[ask.kind]} ·{" "}
                {ask.status === "answered"
                  ? "Answered"
                  : ask.status === "withdrawn"
                    ? "Withdrawn"
                    : "Archived"}
              </Text>
              {ask.rounds.map((round) => (
                <View key={round.number} className="gap-2">
                  <Text className="font-t3-bold text-sm text-foreground">Round {round.number}</Text>
                  {round.questionIds.map((questionId) => {
                    const question = ask.questions.find((entry) => entry.id === questionId);
                    const answer = round.answers.find((entry) => entry.questionId === questionId);
                    const deferred = round.deferredQuestionIds.includes(questionId);
                    return (
                      <View key={questionId} className="gap-1">
                        <Text className="font-t3-bold text-sm text-foreground">
                          {question?.question ?? "Question no longer available"}
                        </Text>
                        {answer ? (
                          <>
                            <Text className="font-sans text-sm text-foreground-muted">
                              Answer: {answerText(answer.value)}
                            </Text>
                            <Text className="font-sans text-sm text-foreground-muted">
                              {answer.answeredBy.kind === "assistant"
                                ? "Assistant for"
                                : "Answered by"}{" "}
                              {answer.answeredBy.personId} · Recommendation{" "}
                              {answer.recommendationTaken ? "taken" : "overridden"}
                            </Text>
                            {answer.comment ? (
                              <Text className="font-sans text-sm text-foreground-muted">
                                Answer comment: {answer.comment}
                              </Text>
                            ) : null}
                          </>
                        ) : (
                          <Text className="font-sans text-sm text-foreground-muted">
                            {deferred ? "Deferred" : "Not answered"}
                          </Text>
                        )}
                      </View>
                    );
                  })}
                  {round.comment ? (
                    <Text className="font-sans text-sm text-foreground-muted">
                      Round comment: {round.comment}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
