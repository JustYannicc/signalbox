// signalbox: adding a Claude or ChatGPT account to a cloud pool from the phone (#205).
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  type CloudPoolAccountType,
  POOL_INSTANCE_KINDS,
  poolInstanceId,
} from "@t3tools/contracts/accountHub";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Linking, ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { LiveSignInWebView } from "./LiveSignInWebView";

type Props = StaticScreenProps<{
  environmentId: string;
  poolId: string;
  kind: CloudPoolAccountType;
}>;

/**
 * Signs one more account into a pool. Opening the screen starts the sign-in:
 * on Signalbox Cloud the provider's page shows here as a cloud browser's live
 * view, and the account is added as soon as the person finishes, with
 * nothing to copy. Leaving ends a sign-in still under way.
 */
export function AddPoolAccountScreen({ route }: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const windowSize = useWindowDimensions();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const { kind, poolId } = route.params;
  const account = POOL_INSTANCE_KINDS[kind].displayName;
  const instanceId = ProviderInstanceId.make(poolInstanceId(kind, poolId));
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(serverEnvironment.providerAuthState(target)).data;
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  // Only this visit's sign-in counts; an earlier one may still read `succeeded`.
  const [startedFlow, setStartedFlow] = useState<string | null>(null);
  const left = useRef(false);

  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const ours = startedFlow !== null && auth?.flowId === startedFlow;
  const interaction = active && ours ? auth.interaction : null;
  const liveView = interaction?.type === "liveView" ? interaction : null;

  async function run<A>(command: () => Promise<AtomCommandResult<A, unknown>>) {
    const result = await command().catch(() => null);
    setError(null);
    if (result === null) setError("Sign-in failed. Try again.");
    else if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Sign-in failed. Try again.");
    }
    return result?._tag === "Success" ? result.value : null;
  }

  async function begin() {
    const flowId = (await run(() => start(target)))?.flowId ?? null;
    // Left while it started: end it here, so its cloud browser closes.
    if (left.current) {
      if (flowId) void cancel({ environmentId, input: { instanceId, flowId } });
      return;
    }
    setStartedFlow(flowId);
  }

  // Once per visit, as soon as the sign-in state is known.
  const beganOnce = useRef(false);
  const beginOnce = useEffectEvent(() => {
    if (beganOnce.current) return;
    beganOnce.current = true;
    void begin();
  });
  const ready = auth !== undefined;
  useEffect(() => {
    if (ready) beginOnce();
  }, [ready]);

  const finished = useEffectEvent(() => navigation.goBack());
  const succeeded = ours && auth?.phase === "succeeded";
  useEffect(() => {
    if (succeeded) finished();
  }, [succeeded]);

  // Leaving ends a sign-in still under way, so its cloud browser closes.
  const abandon = useEffectEvent(() => {
    left.current = true;
    if (startedFlow && active) {
      void cancel({ environmentId, input: { instanceId, flowId: startedFlow } });
    }
  });
  useEffect(() => {
    // Back after a remount (React's strict mode does one), the visit goes on.
    left.current = false;
    return abandon;
  }, []);

  const status = error
    ? error
    : !ours || auth?.phase === "starting"
      ? "Starting sign-in…"
      : auth?.phase === "verifying"
        ? "Checking the account…"
        : auth?.phase === "succeeded"
          ? `${account} account added.`
          : auth?.phase === "failed"
            ? (auth.message ?? "Sign-in failed. Try again.")
            : liveView
              ? `Signing in to ${account}…`
              : interaction?.type === "deviceCode"
                ? `Open the sign-in page and enter ${interaction.userCode}.`
                : `Sign in to ${account}, then paste the address the page ends on.`;
  const ended = ours && (auth?.phase === "failed" || auth?.phase === "cancelled");

  return (
    <SettingsScreen title={`Add ${account} account`}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-4 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {status}
        </Text>
        {liveView ? (
          <>
            <View
              className="overflow-hidden rounded-xl border border-border-subtle bg-subtle"
              // The whole page at the phone's width, leaving room for the status and Cancel.
              style={{
                height: Math.min(
                  ((windowSize.width - 32) * liveView.viewport.height) / liveView.viewport.width,
                  windowSize.height - 340,
                ),
              }}
            >
              <LiveSignInWebView
                url={liveView.url}
                site={liveView.site}
                account={account}
                viewport={liveView.viewport}
              />
            </View>
            <View className="flex-row items-center justify-center gap-1.5">
              <SymbolView
                name={{ ios: "lock.fill", android: "lock" }}
                size={11}
                tintColorClassName="accent-foreground-muted"
              />
              <Text className="text-xs text-foreground-muted">
                {liveView.site} in a cloud browser
              </Text>
            </View>
          </>
        ) : interaction?.type === "browser" || interaction?.type === "deviceCode" ? (
          // A server without a sign-in browser: the person's own browser, then the address back.
          <View className="gap-3">
            <Button
              label="Open sign-in page"
              icon="globe"
              onPress={() =>
                void Linking.openURL(interaction.url).catch(() =>
                  setError("Could not open the sign-in page."),
                )
              }
            />
            {interaction.type === "browser" && interaction.acceptsCallback ? (
              <>
                <TextInput
                  accessibilityLabel="Address of the page that did not load"
                  className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
                  placeholderTextColorClassName="accent-foreground-muted"
                  placeholder="Paste the full address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={pasted}
                  onChangeText={setPasted}
                />
                <Button
                  label="Finish sign-in"
                  tone="primary"
                  disabled={!pasted.trim()}
                  onPress={() => {
                    if (!startedFlow) return;
                    void run(() =>
                      complete({
                        environmentId,
                        input: { instanceId, flowId: startedFlow, callbackUrl: pasted.trim() },
                      }),
                    );
                  }}
                />
              </>
            ) : null}
          </View>
        ) : null}
        {ended || (error && !active) ? (
          <Button label="Try again" tone="primary" fullWidth onPress={() => void begin()} />
        ) : (
          <Button label="Cancel" tone="text" fullWidth onPress={() => navigation.goBack()} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
