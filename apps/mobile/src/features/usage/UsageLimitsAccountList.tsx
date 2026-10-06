import { useNavigation } from "@react-navigation/native";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  displayLimitWindows,
  formatDuration,
  type LimitAccount,
  type LimitPool,
} from "@t3tools/shared/usageLimits";
import { windowResetCredits } from "@t3tools/shared/usageLimitWindows";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { HubAccountActions } from "../accountHub/HubAccountActions";
import { AccountLimits } from "./UsageLimitsSection";

const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  grok: "Grok",
  antigravity: "Antigravity",
};

function driverLabel(account: LimitAccount) {
  return DRIVER_LABEL[account.driver] ?? String(account.driver);
}

// The email tells accounts apart; the instance name is the same for every pooled account.
function accountLabel(account: LimitAccount) {
  return account.email ?? account.displayName ?? driverLabel(account);
}

/**
 * Banked credits as text. Redeeming lives on the account screen, per window,
 * so the row only says what is banked. Claude banks per window, so each
 * window names its own count.
 */
function resetCreditSummary(
  account: LimitAccount,
  windows: readonly ServerProviderUsageWindow[],
  now: number,
) {
  const credits = account.limits.resetCredits;
  if (!credits || credits.availableCount === 0) return "No reset credits banked";
  if (credits.windows) {
    const perWindow = windows.flatMap((window) => {
      const count = windowResetCredits(account, window.id)?.availableCount ?? 0;
      return count > 0 ? [`${count} for ${window.label}`] : [];
    });
    if (perWindow.length > 0) return `Reset credits banked: ${perWindow.join(" · ")}`;
  }
  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  return `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${expiresIn ? ` · next expires in ${expiresIn}` : ""}`;
}

/** Each row uses the native account bars and routes its detail button to the existing account screen. */
export function UsageLimitsAccountList({
  pools,
  now,
  environmentIds,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const navigation = useNavigation();
  if (pools.length === 0) return null;

  const rows = pools.flatMap((pool) =>
    pool.accounts.map((account) => ({ pool, account, windows: displayLimitWindows(pool) })),
  );

  return (
    <View className="gap-2">
      <Text className="text-base font-t3-medium text-foreground">Accounts</Text>
      <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
        {rows.map(({ pool, account, windows }, index) => {
          const accountWindows = windows.flatMap((window) => {
            const member = window.members.find(
              (candidate) => candidate.account.key === account.key,
            );
            return member ? [member.window] : [];
          });
          const firstWindow = windows.find((window) =>
            window.members.some((member) => member.account.key === account.key),
          );
          const name = accountLabel(account);
          const instanceLabel = name;
          const location =
            account.environments.length > 0
              ? `On ${account.environments.map((environment) => environment.label).join(", ")}`
              : account.sourceLabel
                ? `From ${account.sourceLabel}`
                : null;
          // A native login of the same account can still work; the hub's copy cannot.
          const signedOut = account.hubAccount?.signedOut === true;

          return (
            <AccountLimits
              key={account.key}
              first={index === 0}
              driver={pool.driver}
              label={name}
              instanceLabel={instanceLabel}
              detail={account.plan}
              limits={account.limits}
              windows={accountWindows}
              now={now}
              revealInstanceLabel
              showExternalUsage={false}
              trailing={
                <View className="flex-row items-center gap-2">
                  <HubAccountActions account={account} />
                  {firstWindow ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Details for ${name}`}
                      onPress={() => {
                        navigation.navigate("SettingsSheet", {
                          screen: "SettingsContent",
                          params: {
                            screen: "SettingsUsageAccount",
                            params: {
                              accountKey: account.key,
                              windowId: firstWindow.id,
                              windowKind: firstWindow.kind,
                              environmentIds,
                              now,
                            },
                          },
                        });
                      }}
                      className="min-h-11 justify-center rounded-full bg-subtle-strong px-3"
                    >
                      <Text className="text-xs font-t3-medium text-foreground">Details</Text>
                    </Pressable>
                  ) : null}
                </View>
              }
              footer={
                <View className="gap-2">
                  {account.hubAccount?.disabled ? (
                    <Text className="text-xs font-t3-medium text-foreground-secondary">Paused</Text>
                  ) : null}
                  {signedOut ? (
                    <View className="flex-row">
                      <StatusPill
                        size="compact"
                        label={accountWindows.length > 0 ? "Signed out in hub" : "Signed out"}
                        pillClassName="bg-danger"
                        textClassName="text-danger-foreground"
                      />
                    </View>
                  ) : null}
                  {accountWindows.length === 0 &&
                  !account.hubAccount?.disabled &&
                  account.limits.unavailable?.message ? (
                    <Text className="text-xs text-foreground-tertiary">
                      {account.limits.unavailable.message}
                    </Text>
                  ) : null}
                  {location ? (
                    <Text className="text-xs text-foreground-tertiary" numberOfLines={2}>
                      {location}
                    </Text>
                  ) : null}
                  <Text className="text-xs tabular-nums text-foreground-tertiary">
                    {resetCreditSummary(account, accountWindows, now)}
                  </Text>
                </View>
              }
            />
          );
        })}
      </View>
    </View>
  );
}
