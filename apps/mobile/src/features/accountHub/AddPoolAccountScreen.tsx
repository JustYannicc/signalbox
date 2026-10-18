// signalbox: adding a Claude or ChatGPT account to a cloud pool from the phone (#205).
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { isSignInHandBack } from "@t3tools/client-runtime/state/signalboxPoolSignIn";
import { signInFailureMessage } from "@t3tools/client-runtime/state/signalboxSignIn";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  type CloudPoolAccountType,
  POOL_INSTANCE_KINDS,
  poolInstanceId,
} from "@t3tools/contracts/accountHub";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Linking, ScrollView, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type Props = StaticScreenProps<{
  environmentId: string;
  poolId: string;
  kind: CloudPoolAccountType;
}>;

/**
 * Signs one more account into a pool. Opening the screen starts the sign-in,
 * and the provider's real page opens in the phone's browser. ChatGPT gives a
 * code to enter there and finishes on its own; Claude's page ends on a code to
 * paste back here once. Leaving ends a sign-in still under way.
 */
export function AddPoolAccountScreen({ route }: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
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
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  // Only this visit's sign-in counts; an earlier one may still read `succeeded`.
  const [startedFlow, setStartedFlow] = useState<string | null>(null);
  // The pool's flow before this visit's start: the state still shows it until the new one lands.
  const [priorFlow, setPriorFlow] = useState<string | null>(null);
  // A flow the Cancel button is already ending; leaving must not end it a second time.
  const cancelling = useRef<string | null>(null);
  const left = useRef(false);
  const opened = useRef<string | null>(null);

  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const ours = startedFlow !== null && auth?.flowId === startedFlow;
  // Another device started a newer sign-in on this pool; it isn't this screen's to show or end.
  const superseded = startedFlow !== null && !!auth?.flowId && !ours && auth.flowId !== priorFlow;
  const interaction = active && ours ? auth.interaction : null;
  const deviceCode = interaction?.type === "deviceCode" ? interaction : null;
  const browser = interaction?.type === "browser" ? interaction : null;
  const pastes = browser !== null && (browser.acceptsCode === true || browser.acceptsCallback);
  const showsCode = browser?.acceptsCode === true && !browser.acceptsCallback;

  /** One command at a time, so a paste and a tap can't hand the same code back twice. */
  async function run<A>(command: () => Promise<AtomCommandResult<A, unknown>>) {
    if (pendingRef.current) return null;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command().catch(() => null);
    setError(result === null ? "Sign-in failed. Try again." : signInFailureMessage(result));
    pendingRef.current = false;
    setPending(false);
    return result?._tag === "Success" ? result.value : null;
  }

  const cancelFlow = (flowId: string) => cancel({ environmentId, input: { instanceId, flowId } });

  const openPage = (url: string) =>
    void Linking.openURL(url).catch(() => setError("Could not open the sign-in page."));

  async function begin() {
    setPasted("");
    setStartedFlow(null);
    setPriorFlow(auth?.flowId ?? null);
    cancelling.current = null;
    opened.current = null;
    // No callbackMode: nothing on the phone can take a localhost redirect.
    const flowId = (await run(() => start(target)))?.flowId ?? null;
    // Left while it started: end it here, so the pool stops waiting on it.
    if (left.current) {
      if (flowId) void cancelFlow(flowId);
      return;
    }
    setStartedFlow(flowId);
  }

  function finish(text: string) {
    if (!startedFlow || !text) return;
    void run(() =>
      complete({ environmentId, input: { instanceId, flowId: startedFlow, callbackUrl: text } }),
    );
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

  // The provider's page opens by itself; a device code waits for its button, so the
  // person sees the code before leaving for the browser.
  const browserUrl = browser?.url ?? null;
  const openOnce = useEffectEvent((url: string) => {
    if (opened.current === url) return;
    opened.current = url;
    openPage(url);
  });
  useEffect(() => {
    if (browserUrl) openOnce(browserUrl);
  }, [browserUrl]);

  const succeeded = ours && auth?.phase === "succeeded";
  useEffect(() => {
    if (succeeded) navigation.goBack();
  }, [succeeded, navigation]);

  // Leaving ends this visit's sign-in unless it already ended, so the pool stops
  // waiting on it; the state may not have caught up with a start that just returned.
  const ended = superseded || (ours && (auth?.phase === "failed" || auth?.phase === "cancelled"));
  const abandon = useEffectEvent(() => {
    left.current = true;
    if (startedFlow && !ended && !succeeded && cancelling.current !== startedFlow) {
      void cancelFlow(startedFlow);
    }
  });
  useEffect(() => {
    // Back after a remount (React's strict mode does one), the visit goes on.
    left.current = false;
    return abandon;
  }, []);

  const status = (() => {
    if (error) return error;
    if (superseded) return "A sign-in started on another device replaced this one.";
    if (!ours || auth?.phase === "starting") return "Starting sign-in…";
    if (auth?.phase === "verifying") return "Checking the account…";
    if (auth?.phase === "succeeded") return `${account} account added.`;
    if (auth?.phase === "failed") return auth.message ?? "Sign-in failed. Try again.";
    if (deviceCode) {
      return `Copy this code and enter it on the ${account} page. Signalbox finishes on its own.`;
    }
    if (showsCode) {
      return `Sign in to ${account} in your browser. It ends on a page with a code: copy it and paste it here.`;
    }
    return `Sign in to ${account} in your browser, then paste the address the page ends on.`;
  })();

  return (
    <SettingsScreen title={`Add ${account} account`}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-3 px-4 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {status}
        </Text>
        {deviceCode ? (
          <>
            <Text
              selectable
              accessibilityLabel={`Code ${deviceCode.userCode.split("").join(" ")}`}
              className="py-2 text-center font-mono text-3xl tracking-widest text-foreground"
            >
              {deviceCode.userCode}
            </Text>
            <Button
              label={`Copy code and open ${account}`}
              icon="doc.on.doc"
              tone="primary"
              fullWidth
              onPress={() =>
                void tryCopyTextWithHaptic(deviceCode.userCode, { target: "sign-in code" }).then(
                  () => openPage(deviceCode.url),
                )
              }
            />
          </>
        ) : null}
        {browser ? (
          <Button
            label="Open sign-in page again"
            icon="globe"
            tone="text"
            fullWidth
            onPress={() => openPage(browser.url)}
          />
        ) : null}
        {pastes && auth?.phase === "waiting" ? (
          <>
            <TextInput
              accessibilityLabel={
                showsCode ? "Code from the sign-in page" : "Address of the page that did not load"
              }
              className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder={showsCode ? "Paste the code" : "Paste the full address"}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              value={pasted}
              onChangeText={(text) => {
                setPasted(text);
                // A whole paste finishes at once; typing waits for the button.
                const trimmed = text.trim();
                if (trimmed.length - pasted.trim().length > 1 && isSignInHandBack(trimmed)) {
                  finish(trimmed);
                }
              }}
              editable={!pending}
              onSubmitEditing={() => finish(pasted.trim())}
              returnKeyType="done"
            />
            <Button
              label="Finish sign-in"
              tone="primary"
              fullWidth
              disabled={pending || !pasted.trim()}
              onPress={() => finish(pasted.trim())}
            />
          </>
        ) : null}
        {ended || (error && !active) ? (
          <Button
            label="Try again"
            tone="primary"
            fullWidth
            disabled={pending}
            onPress={() => void begin()}
          />
        ) : (
          <Button
            label="Cancel"
            tone="text"
            fullWidth
            disabled={pending}
            onPress={() => {
              if (!startedFlow || !ours || !active) return navigation.goBack();
              // A save already under way can still win: leave only once the cancel took,
              // and otherwise let the subscribed phase say what happened.
              const flowId = startedFlow;
              cancelling.current = flowId;
              void run(() => cancelFlow(flowId)).then((state) => {
                // Already gone: a back swipe closed the screen, so `goBack` would pop the one
                // below. A cancel that failed is sent again, since nothing else ends it now.
                if (left.current || !navigation.isFocused()) {
                  if (!state) void cancelFlow(flowId);
                  return;
                }
                if (state?.flowId === flowId && state.phase === "cancelled") {
                  return navigation.goBack();
                }
                cancelling.current = null;
              });
            }}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
