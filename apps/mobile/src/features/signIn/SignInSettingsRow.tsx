import { useSignInGrantsEnvironmentId } from "../../state/signalboxSignIn";
import { SettingsRow } from "../settings/components/SettingsRow";

/** Settings' way into where agents sign in as you, where an environment keeps grants. */
export function SignInSettingsRow() {
  return useSignInGrantsEnvironmentId() === null ? null : (
    <SettingsRow
      icon={{ ios: "key", android: "lock" }}
      label="Signing in"
      target="SettingsSignIn"
    />
  );
}
