import { waitingQuestionForRun } from "@t3tools/client-runtime/automations/list";
import type { EnvironmentId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Linking, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { AskAnswer } from "../automations/AskAnswer";
import { useAutomationLists } from "../automations/automation-data";
import { PillButton } from "../automations/AutomationParts";

/**
 * A tab the agent handed to the person (#579): what they're asked to do, and
 * the "Payment" automation's question answered right here, so paying and
 * saying how it went never leave the agent's browser.
 */
export const AgentBrowserHandoffNotice = memo(function AgentBrowserHandoffNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly site: string;
  readonly runId: string | null;
  readonly ownBrowserUrl: string | null;
}) {
  const { environmentId, site, runId, ownBrowserUrl } = props;
  const lists = useAutomationLists();
  const question = useMemo(
    () =>
      runId === null
        ? undefined
        : waitingQuestionForRun(
            lists.flatMap(({ environment, automations }) =>
              (automations ?? []).map((automation) => ({
                environmentId: environment.environmentId,
                automation,
              })),
            ),
            environmentId,
            runId,
          ),
    [environmentId, runId, lists],
  );

  return (
    <View className="gap-3 border-b border-border-subtle bg-sheet p-3">
      <View className="gap-1">
        <AppText textRole="body" className="font-t3-medium text-foreground">
          Finish the payment on {site}
        </AppText>
        <AppText textRole="footnote" className="text-foreground-muted">
          Take over and pay here. The agent waits until you say how it went.
        </AppText>
      </View>
      {question === undefined ? null : (
        <AskAnswer
          environmentId={environmentId}
          question={question}
          showQuestion={false}
          showOpen={false}
        />
      )}
      {ownBrowserUrl === null ? null : (
        <View className="flex-row">
          <PillButton
            label="Pay in your own browser"
            icon="safari"
            accessibilityRole="link"
            onPress={() => void Linking.openURL(ownBrowserUrl)}
          />
        </View>
      )}
    </View>
  );
});
