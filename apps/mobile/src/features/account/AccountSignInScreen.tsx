import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SignalboxMark } from "../../components/SignalboxMark";
import { socialProviders } from "./signInLogic";
import { OrDivider, PrimaryButton, ProviderButton } from "./SignInControls";
import { useAccountSignIn, type AccountServerState } from "./useAccountSignIn";

/**
 * Signalbox's own sign-in screen, always to Signalbox Cloud. WorkOS only
 * appears inside the system browser sheet once a provider is picked. Used as
 * Home when nothing is connected yet, and as a modal from the dev-only
 * pairing screen.
 */
export function AccountSignInScreen(props: {
  readonly onSignedIn?: () => void;
  /** Shown as a close button when presented modally. */
  readonly onClose?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const signIn = useAccountSignIn(props.onSignedIn ? { onSignedIn: props.onSignedIn } : {});
  const { server } = signIn;
  const [email, setEmail] = useState("");
  const busy = signIn.pendingProvider !== null;

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
          <Heading server={server} />

          {server._tag === "checking" ? (
            <View className="items-center">
              <ActivityIndicator colorClassName="accent-foreground-muted" />
            </View>
          ) : server._tag === "unreachable" ? (
            <View className="gap-3">
              <ErrorBanner message="Couldn't reach Signalbox. Check your connection." />
              <PrimaryButton label="Try again" onPress={signIn.retry} />
            </View>
          ) : server._tag === "unavailable" ? (
            <View className="gap-3">
              <ErrorBanner message="Signalbox isn't taking sign-ins right now. Try again in a bit." />
              <PrimaryButton label="Try again" onPress={signIn.retry} />
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

function Heading(props: { readonly server: AccountServerState }) {
  const detail = props.server._tag === "checking" ? "Connecting…" : null;

  return (
    <View className="items-center gap-5">
      <SignalboxMark height={44} colorClassName="accent-foreground" />
      <View className="items-center gap-2">
        <Text accessibilityRole="header" className="text-center text-2xl font-t3-bold">
          Sign in to Signalbox
        </Text>
        {detail ? (
          <Text className="text-center text-base text-foreground-muted">{detail}</Text>
        ) : null}
      </View>
    </View>
  );
}
