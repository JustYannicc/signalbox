import { groupConnectedServices } from "@t3tools/client-runtime/automations/connectedServices";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AutomationConnectionStatus } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ServiceLogo } from "../automations/ServiceLogo";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const EXECUTOR_HOME = "https://executor.sh";
const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };

/** The URL's host for display; env-var URLs aren't normalized, so a bad one shows as is. */
const hostOf = (url: string | null) => {
  if (!url) return "Executor";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "Something went wrong.";

/** The Executor connection automations reach the user's accounts through with `w.call`, per environment. */
export function SettingsConnectedServicesRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Connected services" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            Automations use these accounts through w.call. Executor holds the logins; the server
            keeps only Executor's key.
          </Text>
          {selectedTargets.length === 0 ? (
            <Text className="px-2 text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentServices
                key={environment.environmentId}
                environment={environment}
                showLabel={selectedTargets.length > 1}
              />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentServices(props: {
  readonly environment: SettingsTarget;
  readonly showLabel: boolean;
}) {
  const environmentId = props.environment.environmentId;
  const query = useEnvironmentQuery(automationState.connectionStatus({ environmentId, input: {} }));
  const disconnect = useAtomCommand(automationState.disconnect, COMMAND_OPTIONS);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;
  const title = props.showLabel ? props.environment.label : "Executor";

  if (status === null) {
    return (
      <SettingsSection title={title}>
        <Text className="p-4 text-foreground-muted">
          {query.error ? `Couldn't load connected services: ${query.error}` : "Checking…"}
        </Text>
      </SettingsSection>
    );
  }

  const envManaged = status.source === "environment";
  const groups = groupConnectedServices(status.services);

  return (
    <>
      <SettingsSection title={title}>
        <StatusLine status={status} />
        {status.configured && !status.error
          ? groups.map((group) => (
              <View key={group.integration} className="flex-row items-center gap-3 px-4 py-3">
                <ServiceLogo verb="call" service={group.domain} size={30} />
                <View className="min-w-0 flex-1">
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {group.label}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {group.accounts.join(", ")}
                  </Text>
                </View>
              </View>
            ))
          : null}
        {status.configured && !status.error && groups.length === 0 ? (
          <Text className="px-4 pb-4 text-sm text-foreground-muted">
            Nothing connected yet. Connect Gmail, GitHub, Linear and more in Executor.
          </Text>
        ) : null}
        {status.configured && status.url ? (
          <SettingsActionRow
            icon="arrow.up.right"
            label="Manage connections in Executor"
            onPress={() => void Linking.openURL(status.url!)}
          />
        ) : null}
        {status.configured && !envManaged && !editing ? (
          <SettingsActionRow
            icon="pencil"
            label={status.error ? "Update URL or key" : "Change URL or key"}
            onPress={() => setEditing(true)}
          />
        ) : null}
        {status.configured && !envManaged ? (
          <SettingsActionRow
            icon="xmark.circle.fill"
            label="Disconnect"
            tone="danger"
            loading={pending}
            disabled={pending}
            onPress={() => {
              setPending(true);
              setError(null);
              void disconnect({ environmentId, input: {} })
                .then((outcome) => {
                  if (outcome._tag === "Failure")
                    setError(messageOf(squashAtomCommandFailure(outcome)));
                  else setEditing(false);
                })
                .finally(() => setPending(false));
            }}
          />
        ) : null}
        {error ? <Text className="px-4 pb-4 text-sm text-danger-foreground">{error}</Text> : null}
      </SettingsSection>
      {!envManaged && (!status.configured || editing) ? (
        <ConnectForm
          environmentId={environmentId}
          initialUrl={status.url ?? ""}
          onDone={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function StatusLine({ status }: { readonly status: AutomationConnectionStatus }) {
  const host = hostOf(status.url);
  const text = !status.configured
    ? "Not connected. Connect Executor so automations can use your accounts."
    : status.error
      ? status.error
      : `Connected to ${host}${status.source === "environment" ? " · set by the server's environment variables" : ""}`;
  return (
    <Text
      className={
        status.error
          ? "px-4 pt-4 pb-2 text-sm text-danger-foreground"
          : "px-4 pt-4 pb-2 text-sm text-foreground-muted"
      }
    >
      {text}
    </Text>
  );
}

function ConnectForm(props: {
  readonly environmentId: SettingsTarget["environmentId"];
  readonly initialUrl: string;
  readonly onDone: () => void;
}) {
  const connect = useAtomCommand(automationState.connect, COMMAND_OPTIONS);
  const [url, setUrl] = useState(props.initialUrl);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = url.trim() !== "" && apiKey.trim() !== "" && !pending;
  const inputClassName =
    "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

  return (
    <SettingsSection title="Connect Executor">
      <View className="gap-3 p-4">
        <TextInput
          accessibilityLabel="Executor URL"
          className={inputClassName}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder={EXECUTOR_HOME}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!pending}
          value={url}
          onChangeText={setUrl}
        />
        <TextInput
          accessibilityLabel="API key"
          className={inputClassName}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="API key from Executor"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!pending}
          value={apiKey}
          onChangeText={setApiKey}
        />
        <Text
          className={error ? "text-sm text-danger-foreground" : "text-sm text-foreground-muted"}
        >
          {error ??
            "No Executor yet? Get one at executor.sh, connect your accounts there, then paste its URL and an API key."}
        </Text>
      </View>
      <SettingsActionRow
        icon="link"
        label={pending ? "Checking…" : "Connect"}
        loading={pending}
        disabled={!canSubmit}
        onPress={() => {
          setPending(true);
          setError(null);
          void connect({ environmentId: props.environmentId, input: { url, apiKey } })
            .then((outcome) => {
              if (outcome._tag === "Failure") {
                setError(messageOf(squashAtomCommandFailure(outcome)));
                return;
              }
              setApiKey("");
              props.onDone();
            })
            .finally(() => setPending(false));
        }}
      />
      {props.initialUrl ? (
        <SettingsActionRow icon="xmark" label="Cancel" disabled={pending} onPress={props.onDone} />
      ) : (
        <SettingsActionRow
          icon="arrow.up.right"
          label="Get Executor"
          onPress={() => void Linking.openURL(EXECUTOR_HOME)}
        />
      )}
    </SettingsSection>
  );
}
