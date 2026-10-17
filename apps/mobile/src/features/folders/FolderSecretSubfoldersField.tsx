import {
  addSubfolderSecretName,
  isSecretEnvironmentName,
  setSubfolderSecretIncluded,
} from "@t3tools/client-runtime/state/folderSecrets";
import { useState, type Dispatch, type SetStateAction } from "react";
import { Pressable, View } from "react-native";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";

export function FolderSecretSubfoldersField(props: {
  readonly topLevel: boolean;
  readonly names: ReadonlyArray<string>;
  readonly includedNames: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly onNamesChange: Dispatch<SetStateAction<ReadonlyArray<string>>>;
  readonly onIncludedNamesChange: Dispatch<SetStateAction<ReadonlyArray<string>>>;
}) {
  const [keyName, setKeyName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addKeyName = () => {
    const name = keyName.trim();
    if (name.length === 0) return setError("Enter an environment variable name.");
    if (!isSecretEnvironmentName(name)) {
      return setError("Use letters, numbers and underscores; start with a letter or underscore.");
    }
    const next = addSubfolderSecretName(props.names, name);
    if (next === props.names) return setError("That name is already listed.");
    props.onNamesChange(next);
    setKeyName("");
    setError(null);
  };

  return (
    <View className="gap-2">
      <View className="gap-1">
        <AppText className="text-sm font-t3-medium">Include in subfolders</AppText>
        <AppText className="text-xs text-foreground-muted">
          {props.topLevel
            ? "By default, this Environment's variables go only to threads in the top level."
            : "By default, this Environment's variables go only to threads in this folder."}{" "}
          To share one with child folders, enter its exact variable name and turn on Include
          subfolders. Changes apply on the next turn. Only enabled names are saved. Add a name again
          to opt it in later.
        </AppText>
      </View>
      <View className="gap-2">
        <AppText className="text-sm font-t3-medium">Environment variable name</AppText>
        <AppTextInput
          accessibilityLabel="Environment variable name"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!props.disabled && props.enabled}
          onChangeText={(value) => {
            setKeyName(value);
            setError(null);
          }}
          onSubmitEditing={addKeyName}
          placeholder="API_KEY"
          returnKeyType="done"
          spellCheck={false}
          value={keyName}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled || !props.enabled }}
          className={
            props.disabled || !props.enabled
              ? "min-h-12 items-center justify-center rounded-full bg-subtle px-4"
              : "min-h-12 items-center justify-center rounded-full bg-primary px-4 active:opacity-75"
          }
          disabled={props.disabled || !props.enabled}
          onPress={addKeyName}
        >
          <AppText
            className={
              props.disabled || !props.enabled
                ? "text-sm font-t3-medium text-foreground-tertiary"
                : "text-sm font-t3-medium text-primary-foreground"
            }
          >
            Add name
          </AppText>
        </Pressable>
      </View>
      {error ? (
        <AppText accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error}
        </AppText>
      ) : null}
      {props.names.length === 0 ? (
        <AppText className="text-xs text-foreground-muted">
          No names listed. Add a name to choose whether it reaches subfolders.
        </AppText>
      ) : (
        <View>
          {props.names.map((name) => (
            <View
              key={name}
              className="min-h-14 flex-row items-center gap-3 border-b border-border py-2"
            >
              <AppText className="min-w-0 flex-1 font-mono text-sm" numberOfLines={1}>
                {name}
              </AppText>
              <ThemedSwitch
                accessibilityLabel={`Include ${name} in subfolders`}
                accessibilityHint="Allows this key to reach threads in child folders."
                disabled={props.disabled}
                value={props.includedNames.includes(name)}
                onValueChange={(value) =>
                  props.onIncludedNamesChange((currentNames) =>
                    setSubfolderSecretIncluded(currentNames, name, value),
                  )
                }
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
