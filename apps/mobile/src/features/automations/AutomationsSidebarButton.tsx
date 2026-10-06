import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { useWaitingAutomationCount } from "./automation-data";

/**
 * The iPad sidebar's way into Automations, beside Settings. A dot marks
 * automations waiting on an answer.
 */
export function AutomationsSidebarButton() {
  const navigation = useNavigation();
  const waiting = useWaitingAutomationCount() > 0;
  return (
    <Pressable
      className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={waiting ? "Open automations, some need you" : "Open automations"}
      accessibilityRole="button"
      hitSlop={4}
      onPress={() => navigation.navigate("Automations")}
    >
      <SymbolView
        name="bolt.circle"
        size={18}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      {waiting ? (
        <View className="absolute top-2 right-2 size-2 rounded-full bg-warning-foreground" />
      ) : null}
    </Pressable>
  );
}
