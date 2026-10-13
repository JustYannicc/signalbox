import { View } from "react-native";

/** A red dot in the icon's corner while something behind the row needs the user. */
export function AttentionDot() {
  return <View className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500" />;
}

/** The row's spoken label, which says when the row needs attention. */
export function attentionLabel(label: string, attention: boolean | undefined): string {
  return attention ? `${label}, needs attention` : label;
}
