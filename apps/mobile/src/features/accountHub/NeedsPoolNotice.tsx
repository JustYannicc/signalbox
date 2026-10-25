// signalbox: what the composer says while its project needs a pool.
import type { PoolNeed } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/** Its action opens Usage → Limits, where the pool's state is shown; on Signalbox Cloud, an account can be added there. */
export function NeedsPoolNotice(props: {
  readonly environmentId: EnvironmentId | null;
  readonly need: PoolNeed;
}) {
  const navigation = useNavigation();
  const configs = useServerConfigs();
  const cloud =
    props.environmentId !== null &&
    configs.get(props.environmentId)?.environment.capabilities.signalboxCloud === true;
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
      ? cloud
        ? `Needs a pool. Add an account to ${poolName ?? "its pool"}.`
        : `Needs a pool. Sign in to ${poolName ?? "its pool"} on web or desktop.`
      : need._tag === "noPool"
        ? "Needs a pool. Nothing above this folder has one."
        : `Needs a pool. ${need.message}`;
  const action =
    need._tag === "noModels" || need._tag === "unavailable" ? "Check pool" : "Open pools";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens pool status in Usage limits"
      className="px-3 py-2"
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsUsage" },
        })
      }
    >
      <Text className="text-xs text-foreground">
        {message} <Text className="text-xs font-t3-medium text-primary">{action}</Text>
      </Text>
    </Pressable>
  );
}
