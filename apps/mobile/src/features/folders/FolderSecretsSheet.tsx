// signalbox: edit a folder's 1Password Environment and the key names it shares below.
import {
  formatSecretSources,
  planSecretsSave,
  resetSubfolderSecretNamesForEnvironment,
} from "@t3tools/client-runtime/state/folderSecrets";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { FolderSecretSubfoldersField } from "./FolderSecretSubfoldersField";
import type { SecretsEditing } from "./use-folder-actions";

function HeaderButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      className="min-h-11 min-w-16 justify-center px-3 active:opacity-65"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <AppText
        className={
          props.disabled
            ? "text-base text-foreground-tertiary"
            : "text-base font-t3-medium text-primary"
        }
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}

export function FolderSecretsSheet(props: {
  readonly editing: SecretsEditing;
  readonly onSave: (
    plan: ReturnType<typeof planSecretsSave>,
    onConnected: () => void,
  ) => Promise<boolean>;
  readonly onRemove: () => Promise<boolean>;
  readonly onDisconnect: () => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { editing } = props;
  const [environmentId, setEnvironmentId] = useState(editing.secrets?.environmentId ?? "");
  const [keyNames, setKeyNames] = useState<ReadonlyArray<string>>(
    editing.secrets?.includeSubfolders ?? [],
  );
  const [includedNames, setIncludedNames] = useState<ReadonlyArray<string>>(
    editing.secrets?.includeSubfolders ?? [],
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const named = environmentId.trim().length > 0;
  const askToken = !editing.onePasswordConnected;
  const plan = planSecretsSave({
    current: editing.secrets,
    environmentId,
    includeSubfolders: includedNames,
    token: askToken ? token : null,
    connected: editing.onePasswordConnected,
  });

  const updateEnvironmentId = (value: string) => {
    setKeyNames((names) => resetSubfolderSecretNamesForEnvironment(environmentId, value, names));
    setIncludedNames((names) =>
      resetSubfolderSecretNamesForEnvironment(environmentId, value, names),
    );
    setEnvironmentId(value);
    setError(null);
  };

  const save = async () => {
    if ("error" in plan) {
      setError(plan.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await props.onSave(plan, () => setToken(""));
      if (saved) props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const removed = await props.onRemove();
      if (removed) props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  const runDisconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      if (await props.onDisconnect()) setToken("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDisconnect = () =>
    Dialog.confirm({
      title: "Disconnect 1Password?",
      message: "Secrets stop loading in all your folders until you connect it again.",
      confirmText: "Disconnect",
      destructive: true,
      onConfirm: () => void runDisconnect(),
    });

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 bg-sheet"
        style={{
          paddingTop: Platform.OS === "ios" ? 0 : insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View className="flex-row items-center gap-2 px-2 py-2">
          <HeaderButton label="Cancel" onPress={props.onClose} />
          <AppText
            accessibilityRole="header"
            className="min-w-0 flex-1 text-center text-base font-t3-semibold"
            numberOfLines={1}
          >
            Secrets
          </AppText>
          <HeaderButton
            label={saving ? "Saving…" : "Save"}
            disabled={saving}
            onPress={() => void save()}
          />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-5 px-4 pt-2 pb-6"
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-1">
            <AppText className="text-sm font-t3-medium">
              {editing.level._tag === "top"
                ? `Top-level secrets · ${editing.name}`
                : `Secrets for ${editing.name}`}
            </AppText>
            <AppText className="text-sm text-foreground-muted">
              {named
                ? "Threads here get this Environment's variables when a turn starts. This form shows names only."
                : "Add a 1Password Environment to load its variables into threads here."}
            </AppText>
          </View>

          {editing.ancestorSources.length > 0 ? (
            <AppText className="text-sm text-foreground-muted">
              Threads here also get opted-in names from{" "}
              {formatSecretSources(editing.ancestorSources)}. This level wins when names clash.
            </AppText>
          ) : null}

          <View className="gap-2">
            <AppText className="text-sm font-t3-medium">1Password Environment ID</AppText>
            <AppTextInput
              accessibilityLabel="1Password Environment ID"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!saving}
              maxLength={128}
              onChangeText={updateEnvironmentId}
              placeholder="Environment ID"
              spellCheck={false}
              value={environmentId}
            />
            <AppText className="text-xs text-foreground-muted">
              In the 1Password app: Developer › View Environments › Manage environment › Copy
              environment ID.
            </AppText>
          </View>

          <FolderSecretSubfoldersField
            key={environmentId}
            topLevel={editing.level._tag === "top"}
            names={keyNames}
            includedNames={includedNames}
            disabled={saving}
            enabled={named}
            onNamesChange={setKeyNames}
            onIncludedNamesChange={setIncludedNames}
          />

          {askToken ? (
            <View className="gap-2">
              <AppText className="text-sm text-foreground-muted">
                1Password isn't connected. Add a service account token to connect it.
              </AppText>
              <AppText className="text-sm font-t3-medium">Service account token</AppText>
              <AppTextInput
                accessibilityLabel="1Password service account token"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!saving}
                onChangeText={(value) => {
                  setToken(value);
                  setError(null);
                }}
                placeholder="ops_…"
                secureTextEntry
                spellCheck={false}
                value={token}
              />
              <AppText className="text-xs text-foreground-muted">
                1Password shows it once when you create a service account with read access to this
                Environment. One token covers your folders.
              </AppText>
            </View>
          ) : (
            <View className="min-h-12 flex-row items-center justify-between gap-3">
              <AppText className="text-sm text-foreground-muted">1Password connected.</AppText>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: saving }}
                className="min-h-12 justify-center px-2 active:opacity-65"
                disabled={saving}
                onPress={confirmDisconnect}
              >
                <AppText className="text-sm font-t3-medium text-danger-foreground">
                  Disconnect
                </AppText>
              </Pressable>
            </View>
          )}

          {error ? (
            <AppText accessibilityRole="alert" className="text-xs text-danger-foreground">
              {error}
            </AppText>
          ) : null}

          {editing.secrets ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving }}
              className="min-h-11 justify-center self-start px-2 active:opacity-65"
              disabled={saving}
              onPress={() => void remove()}
            >
              <AppText className="text-sm font-t3-medium text-danger-foreground">
                Remove Environment
              </AppText>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
