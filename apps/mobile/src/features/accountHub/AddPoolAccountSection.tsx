// signalbox: Usage → Limits offers adding an account to each cloud pool (#205).
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CLOUD_POOL_ACCOUNT_TYPES,
  type CloudPoolAccountType,
  POOL_INSTANCE_KINDS,
} from "@t3tools/contracts/accountHub";
import { Alert } from "react-native";

import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { signalboxCloudIds } from "../agent-awareness/signalboxCloudPush";

/** One row per pool of every cloud environment shown; each asks which kind of account to add. */
export function AddPoolAccountSection(props: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const configs = useServerConfigs();
  const environments = signalboxCloudIds(configs).flatMap((environmentId) => {
    // Like web's `usePoolFeatures`: a server that doesn't say can do everything.
    const features = configs.get(environmentId)?.environment.capabilities.poolFeatures;
    const kinds = CLOUD_POOL_ACCOUNT_TYPES.filter((kind) => !features || features.includes(kind));
    const shown = props.selectedEnvironmentIds?.has(environmentId) ?? true;
    return shown && kinds.length > 0 ? [{ environmentId, kinds }] : [];
  });
  return environments.map(({ environmentId, kinds }) => (
    <PoolRows key={environmentId} environmentId={environmentId} kinds={kinds} />
  ));
}

function PoolRows(props: {
  readonly environmentId: EnvironmentId;
  readonly kinds: ReadonlyArray<CloudPoolAccountType>;
}) {
  const navigation = useNavigation();
  const pools =
    useEnvironmentQuery(
      serverEnvironment.accountPoolViewsLive({ environmentId: props.environmentId, input: {} }),
    ).data ?? [];
  if (pools.length === 0) return null;
  const add = (poolId: string, kind: CloudPoolAccountType) =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsAddPoolAccount",
        params: { environmentId: props.environmentId, poolId, kind },
      },
    });
  return (
    <SettingsSection title="Accounts">
      {pools.map((pool) => (
        <SettingsActionRow
          key={pool.id}
          icon="plus"
          label={pools.length === 1 ? "Add account" : `Add account to ${pool.name}`}
          onPress={() =>
            Alert.alert("Add account", undefined, [
              ...props.kinds.map((kind) => ({
                text: POOL_INSTANCE_KINDS[kind].displayName,
                onPress: () => add(pool.id, kind),
              })),
              { text: "Cancel", style: "cancel" as const },
            ])
          }
        />
      ))}
    </SettingsSection>
  );
}
