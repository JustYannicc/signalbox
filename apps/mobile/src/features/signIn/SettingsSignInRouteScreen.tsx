import {
  personalSignIn,
  signInCheckShown,
  signInFailureMessage,
} from "@t3tools/client-runtime/state/signalboxSignIn";
import type { EnvironmentId } from "@t3tools/contracts";
import { SIGN_IN_EVERYWHERE, type SignInGrant } from "@t3tools/contracts/signalboxSignIn";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { signalboxSignIn, useSignInGrantsEnvironmentId } from "../../state/signalboxSignIn";
import { useAtomCommand } from "../../state/use-atom-command";
import { relativeTime } from "../../lib/time";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

/**
 * Settings → Signing in (#575), the web's Settings → Sign-in: where agents
 * sign in from your own 1Password without asking, and the answer they'd get.
 */
const PERSON = { _tag: "person" } as const;
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };
const INPUT_CLASS_NAME =
  "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

const since = (at: number) => `${relativeTime(new Date(at).toISOString())} ago`;

export function SettingsSignInRouteScreen() {
  const environmentId = useSignInGrantsEnvironmentId();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Signing in">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environmentId === null ? (
          <Text className="px-2 text-foreground-muted">
            Connect to Signalbox Cloud to choose where agents sign in as you.
          </Text>
        ) : (
          <SignInGrants key={environmentId} environmentId={environmentId} />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function SignInGrants({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(signalboxSignIn.grants({ environmentId, input: {} }));
  const canChange = useAtomValue(signalboxSignIn.grant.permissionAtom(environmentId));
  const grant = useAtomCommand(signalboxSignIn.grant, COMMAND_OPTIONS);
  const revoke = useAtomCommand(signalboxSignIn.revoke, COMMAND_OPTIONS);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState("");

  const run = async (key: string, command: () => Promise<string | null>) => {
    setPending(key);
    setError(null);
    try {
      const failure = await command();
      setError(failure);
      return failure === null;
    } finally {
      setPending(null);
    }
  };
  const allow = (key: "everywhere" | "add", value: string) =>
    run(key, async () =>
      signInFailureMessage(await grant({ environmentId, input: { source: PERSON, site: value } })),
    );
  const stop = (granted: SignInGrant) =>
    run(granted.id, async () =>
      signInFailureMessage(await revoke({ environmentId, input: { id: granted.id } })),
    );

  const addSite = () => {
    if (busy || site.trim() === "") return;
    void allow("add", site).then((done) => done && setSite(""));
  };

  if (query.data === null) {
    return (
      <Text className="px-2 text-foreground-muted">
        {query.error ? `Couldn't load your sign-in grants: ${query.error}` : "Loading…"}
      </Text>
    );
  }
  const { everywhere, sites } = personalSignIn(query.data);
  const busy = pending !== null || !canChange;

  return (
    <>
      <SettingsSection footer="Agents sign in from your 1Password without asking you first. Payments always come back to you.">
        <ListToggleRow
          icon="globe"
          label="Sign in everywhere"
          description={everywhere === null ? undefined : `On since ${since(everywhere.grantedAt)}`}
          disabled={busy}
          value={everywhere !== null}
          onValueChange={(on) =>
            void (on ? allow("everywhere", SIGN_IN_EVERYWHERE) : everywhere && stop(everywhere))
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Sites"
        footer={
          everywhere === null
            ? "These, and the addresses under them, sign in without asking. Anywhere else agents ask you first, and Always adds the site here."
            : "These stay allowed if you switch everywhere off."
        }
      >
        {sites.map((granted) => (
          <ListRowLayout
            key={granted.id}
            label={granted.site}
            description={`Allowed ${since(granted.grantedAt)}`}
            accessory={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Revoke ${granted.site}`}
                disabled={busy}
                className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
                onPress={() => void stop(granted)}
              >
                <Text className="text-sm font-t3-medium text-danger-foreground">
                  {pending === granted.id ? "Revoking…" : "Revoke"}
                </Text>
              </Pressable>
            }
          />
        ))}
        <View className="gap-2 p-4">
          <TextInput
            accessibilityLabel="Site to allow"
            className={INPUT_CLASS_NAME}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="booking.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            returnKeyType="done"
            value={site}
            onChangeText={setSite}
            onSubmitEditing={addSite}
          />
          {error === null ? null : <Text className="text-sm text-danger-foreground">{error}</Text>}
        </View>
        <SettingsActionRow
          icon="plus"
          label={pending === "add" ? "Allowing…" : "Allow site"}
          loading={pending === "add"}
          disabled={busy || site.trim() === ""}
          onPress={addSite}
        />
      </SettingsSection>

      <TrySite environmentId={environmentId} />
    </>
  );
}

/** The answer the login service gives for a site, as agents would get it. */
function TrySite({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const check = useAtomCommand(signalboxSignIn.check, COMMAND_OPTIONS);
  const [site, setSite] = useState("");
  const [answer, setAnswer] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const submit = async () => {
    const origin = site.trim();
    if (checking || origin === "") return;
    setChecking(true);
    try {
      const result = await check({ environmentId, input: { source: PERSON, origin } });
      const shown = signInCheckShown(origin, result);
      if (shown !== null) setAnswer(shown);
    } finally {
      setChecking(false);
    }
  };
  return (
    <SettingsSection title="Try a site" footer="See whether agents would sign in or ask you first.">
      <View className="gap-2 p-4">
        <TextInput
          accessibilityLabel="Site to try"
          className={INPUT_CLASS_NAME}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="https://accounts.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          value={site}
          onChangeText={(text) => {
            setSite(text);
            setAnswer(null);
          }}
        />
        {answer === null ? null : (
          <Text
            className={
              answer.failed ? "text-sm text-danger-foreground" : "text-sm text-foreground-muted"
            }
          >
            {answer.text}
          </Text>
        )}
      </View>
      <SettingsActionRow
        icon="magnifyingglass"
        label={checking ? "Checking…" : "Check"}
        loading={checking}
        disabled={checking || site.trim() === ""}
        onPress={() => void submit()}
      />
    </SettingsSection>
  );
}
