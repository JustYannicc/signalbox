import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SignalboxMark } from "../../components/SignalboxMark";
import { serverDisplayHost, socialProviders } from "./signInLogic";
import { OrDivider, PrimaryButton, ProviderButton, QuietLink } from "./SignInControls";
import { useAccountSignIn, type AccountServerState } from "./useAccountSignIn";

/**
 * Signalbox's own sign-in screen. WorkOS only appears inside the system
 * browser sheet once a provider is picked. Used as Home when nothing is
 * connected yet, and as a modal from "Add environment".
 */
export function AccountSignInScreen(props: {
  /** Hand over to code pairing, prefilled with the server when one is known. */
  readonly onPairInstead: (serverUrl: string | null) => void;
  readonly onSignedIn?: () => void;
  /** Shown as a close button when presented modally. */
  readonly onClose?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const signIn = useAccountSignIn({
    onPairingRequired: props.onPairInstead,
    ...(props.onSignedIn ? { onSignedIn: props.onSignedIn } : {}),
  });
  const { server } = signIn;
  const [serverInput, setServerInput] = useState("");
  const [serverInputInvalid, setServerInputInvalid] = useState(false);
  const [email, setEmail] = useState("");
  const busy = signIn.pendingProvider !== null;
  const host = server._tag === "choose" ? null : serverDisplayHost(server.serverUrl);

  const submitServer = () => {
    setServerInputInvalid(!signIn.submitServer(serverInput));
  };
  const changeServer = () => {
    if (server._tag !== "choose") setServerInput(server.serverUrl);
    setServerInputInvalid(false);
    signIn.changeServer();
  };
  const changeServerLink = (
    <QuietLink label="Use a different server" disabled={busy} onPress={changeServer} />
  );

  return (
    <View className="flex-1 bg-screen">
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingTop: insets.top + 48,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 24,
        }}
      >
        <View className="w-full max-w-[400px] gap-8 self-center">
          <Heading server={server} host={host} />

          {server._tag === "choose" ? (
            <View className="gap-3">
              <AppTextInput
                accessibilityLabel="Server address"
                autoCapitalize="none"
                autoComplete="url"
                autoCorrect={false}
                keyboardType="url"
                placeholder="signalbox.example.com"
                returnKeyType="go"
                textContentType="URL"
                value={serverInput}
                onChangeText={(value) => {
                  setServerInput(value);
                  setServerInputInvalid(false);
                }}
                onSubmitEditing={submitServer}
              />
              {serverInputInvalid ? (
                <Text className="px-1 text-sm text-danger-foreground">
                  Enter an address like signalbox.example.com or 192.168.1.5:3773.
                </Text>
              ) : null}
              <PrimaryButton
                label="Continue"
                disabled={serverInput.trim().length === 0}
                onPress={submitServer}
              />
              <QuietLink
                label="Pair with a code instead"
                onPress={() => props.onPairInstead(null)}
              />
            </View>
          ) : server._tag === "checking" ? (
            <View className="items-center gap-6">
              <ActivityIndicator colorClassName="accent-foreground-muted" />
              {changeServerLink}
            </View>
          ) : server._tag === "unreachable" ? (
            <View className="gap-3">
              <ErrorBanner
                message={`Couldn't reach ${host}. Check the address and your connection.`}
              />
              <PrimaryButton label="Try again" onPress={signIn.retry} />
              {changeServerLink}
            </View>
          ) : server._tag === "pairing" ? (
            <View className="gap-3">
              <PrimaryButton
                label="Pair with a code"
                onPress={() => props.onPairInstead(server.serverUrl)}
              />
              {changeServerLink}
            </View>
          ) : (
            <View className="gap-3">
              {signIn.failure ? <ErrorBanner message={signIn.failure} /> : null}
              {socialProviders(server.session.providers).map((provider) => (
                <ProviderButton
                  key={provider}
                  provider={provider}
                  pending={signIn.pendingProvider === provider}
                  disabled={busy}
                  onPress={() => void signIn.signIn(provider)}
                />
              ))}
              {server.session.providers.includes("email") ? (
                <>
                  {socialProviders(server.session.providers).length > 0 ? <OrDivider /> : null}
                  <AppTextInput
                    accessibilityLabel="Email"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect={false}
                    editable={!busy}
                    keyboardType="email-address"
                    placeholder="you@example.com"
                    returnKeyType="go"
                    textContentType="emailAddress"
                    value={email}
                    onChangeText={setEmail}
                    onSubmitEditing={() => void signIn.signIn("email", email.trim())}
                  />
                  <PrimaryButton
                    label="Continue with email"
                    pending={signIn.pendingProvider === "email"}
                    disabled={busy}
                    onPress={() => void signIn.signIn("email", email.trim())}
                  />
                </>
              ) : null}
              <View className="pt-2">{changeServerLink}</View>
            </View>
          )}
        </View>
      </KeyboardAwareScrollView>
      {props.onClose ? (
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={8}
          onPress={props.onClose}
          className="absolute right-4 size-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
          style={{ top: insets.top + 12 }}
        >
          <SymbolView name="xmark" size={14} tintColorClassName="accent-icon" type="monochrome" />
        </Pressable>
      ) : null}
    </View>
  );
}

function Heading(props: { readonly server: AccountServerState; readonly host: string | null }) {
  const { server, host } = props;
  const title = server._tag === "pairing" ? "Pair with a code" : "Sign in to Signalbox";
  const detail =
    server._tag === "choose"
      ? "Enter the address of the server that runs your Signalbox."
      : server._tag === "checking"
        ? `Connecting to ${host}…`
        : server._tag === "pairing"
          ? `${host} connects with a pairing code instead of an account.`
          : host;

  return (
    <View className="items-center gap-5">
      <SignalboxMark height={44} colorClassName="accent-foreground" />
      <View className="items-center gap-2">
        <Text accessibilityRole="header" className="text-center text-2xl font-t3-bold">
          {title}
        </Text>
        <Text className="text-center text-base text-foreground-muted">{detail}</Text>
      </View>
    </View>
  );
}
