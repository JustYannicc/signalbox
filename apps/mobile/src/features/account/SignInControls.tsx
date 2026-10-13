import type { AccountProvider } from "@t3tools/contracts/account";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { ACCOUNT_PROVIDER_LABELS, AccountProviderIcon } from "./AccountProviderIcon";

// Controls owned by the sign-in screen. Busy states keep the tapped control
// solid and dim the rest, so it's obvious which one is working.

export function ProviderButton(props: {
  readonly provider: AccountProvider;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const label = `Continue with ${ACCOUNT_PROVIDER_LABELS[props.provider]}`;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, busy: props.pending }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-[52px] flex-row items-center justify-center gap-3 rounded-[16px] border border-border bg-card px-4 active:opacity-70",
        // The tapped button stays solid while the others step back.
        !props.pending && "disabled:opacity-50",
      )}
    >
      <View className="size-5 items-center justify-center">
        {props.pending ? (
          <ActivityIndicator size="small" colorClassName="accent-foreground" />
        ) : (
          <AccountProviderIcon provider={props.provider} size={20} />
        )}
      </View>
      <Text className="text-base font-t3-medium">{label}</Text>
    </Pressable>
  );
}

export function PrimaryButton(props: {
  readonly label: string;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false, busy: props.pending ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-[52px] flex-row items-center justify-center gap-2 rounded-[16px] bg-primary px-4 active:opacity-70",
        !props.pending && "disabled:opacity-50",
      )}
    >
      {props.pending ? (
        <ActivityIndicator size="small" colorClassName="accent-primary-foreground" />
      ) : null}
      <Text className="text-base font-t3-bold text-primary-foreground">{props.label}</Text>
    </Pressable>
  );
}

export function QuietLink(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="items-center self-center px-3 py-2 active:opacity-60 disabled:opacity-40"
    >
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

export function OrDivider() {
  return (
    <View className="flex-row items-center gap-3 py-1" accessibilityElementsHidden>
      <View className="flex-1 bg-border" style={{ height: StyleSheet.hairlineWidth }} />
      <Text className="text-xs text-foreground-muted">or</Text>
      <View className="flex-1 bg-border" style={{ height: StyleSheet.hairlineWidth }} />
    </View>
  );
}
