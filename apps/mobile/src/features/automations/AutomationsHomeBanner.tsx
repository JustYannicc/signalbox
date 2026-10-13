import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAutomationLists, waitingAutomations } from "./automation-data";
import { StatusDot } from "./AutomationParts";

/**
 * Home's nudge when an automation is blocked on you. Renders nothing otherwise,
 * so it costs no space until it has something to say.
 */
export function AutomationsHomeBanner() {
  const navigation = useNavigation();
  const waiting = waitingAutomations(useAutomationLists());
  const [first] = waiting;
  if (!first) return null;

  const questions = waiting.reduce((sum, entry) => sum + entry.automation.waiting.length, 0);
  const title =
    waiting.length === 1
      ? `${first.automation.name} needs you`
      : `${waiting.length} automations need you`;
  const detail =
    waiting.length === 1
      ? (first.question.question ?? first.question.label)
      : `${questions} questions waiting`;

  return (
    <View className="px-4 pb-2 pt-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${detail}`}
        onPress={() => navigation.navigate("Automations")}
        className="flex-row items-center gap-3 rounded-2xl border border-warning-border bg-warning px-4 py-3 active:opacity-70"
      >
        <StatusDot status="needsYou" size="md" />
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-medium text-warning-foreground" numberOfLines={1}>
            {title}
          </Text>
          <Text className="text-sm text-warning-foreground opacity-80" numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={14} tintColorClassName="accent-warning-foreground" />
      </Pressable>
    </View>
  );
}

/** Home's list header with the banner under whatever header Home already had. */
export function withAutomationsBanner(header: ReactNode) {
  return (
    <>
      {header}
      <AutomationsHomeBanner />
    </>
  );
}
