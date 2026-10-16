import { resolveAddressBarInput } from "@t3tools/shared/preview";
import { type ReactNode, useState } from "react";
import { TextInput, View } from "react-native";

import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";

/**
 * A browser's back, forward, address and reload row. Typed text that isn't
 * an address searches, as in the web and desktop browser panels.
 */
export function AddressBar(props: {
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canReload: boolean;
  readonly editable: boolean;
  readonly autoFocus?: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
  readonly onNavigate: (url: string) => void;
  readonly trailing?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const value = draft ?? props.url;
    setDraft(null);
    if (value.trim().length === 0) return;
    let url: string;
    try {
      url = resolveAddressBarInput(value);
    } catch {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
      return;
    }
    props.onNavigate(url);
  };
  return (
    <View className="flex-row items-center gap-1 px-2 pb-2">
      <ControlPill
        icon="chevron.left"
        accessibilityLabel="Back"
        disabled={!props.canGoBack}
        onPress={props.onBack}
      />
      <ControlPill
        icon="chevron.right"
        accessibilityLabel="Forward"
        disabled={!props.canGoForward}
        onPress={props.onForward}
      />
      <TextInput
        accessibilityLabel="Address"
        autoFocus={props.autoFocus}
        editable={props.editable}
        value={draft ?? props.url}
        onChangeText={setDraft}
        onBlur={() => setDraft(null)}
        onSubmitEditing={submit}
        placeholder="Search or enter a URL"
        placeholderTextColorClassName="accent-placeholder"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
      />
      <ControlPill
        icon="arrow.clockwise"
        accessibilityLabel="Reload page"
        disabled={!props.canReload}
        onPress={props.onReload}
      />
      {props.trailing}
    </View>
  );
}
