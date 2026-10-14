// signalbox: what the composer says while its project needs a pool.
import type { PoolNeed } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/**
 * Its one action opens the pools in Usage. Subscriptions are added on web and
 * desktop, so it says where.
 */
export function NeedsPoolNotice(props: {
  readonly environmentId: EnvironmentId | null;
  readonly need: PoolNeed;
}) {
  const navigation = useNavigation();
  const views = useEnvironmentQuery(
    props.environmentId && props.need._tag === "signIn"
      ? serverEnvironment.accountPoolViewsLive({ environmentId: props.environmentId, input: {} })
      : null,
  ).data;
  const { need } = props;
  const poolName =
    need._tag === "signIn" ? views?.find((view) => view.id === need.poolId)?.name : undefined;
  const message =
    need._tag === "signIn"
      ? `Needs a pool. Sign in to ${poolName ?? "its pool"} on web or desktop.`
      : "Needs a pool. Nothing above this folder has one.";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens your pools in Usage"
      className="px-3 py-2"
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsUsage" },
        })
      }
    >
      <Text className="text-xs text-foreground">
        {message} <Text className="text-xs font-t3-medium text-primary">Open pools</Text>
      </Text>
    </Pressable>
  );
}
