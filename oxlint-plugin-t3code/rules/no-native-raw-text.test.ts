import { describe } from "vite-plus/test";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-native-raw-text", {
  filename: "fixture.tsx",
});

describe("t3code/no-native-raw-text", () => {
  rule.invalid("rejects JSX text", "<View>Sign out</View>");
  rule.invalid(
    "rejects the same-line space from #624",
    "<View><SignInSettingsRow /> {/* sign-in grants */}</View>",
  );
  rule.invalid("rejects an explicit space", '<View>{" "}</View>');
  rule.invalid("rejects an explicit empty string", '<View>{""}</View>');
  rule.invalid("rejects zero", "<View>{0}</View>");
  rule.invalid(
    "rejects text in a ternary branch",
    '<View>{signedIn ? <Account /> : "Signed out"}</View>',
  );
  rule.invalid("rejects guarded text", '<View>{signedIn && "Signed in"}</View>');
  rule.invalid("rejects a leaking count", "<View>{count && <SettingsRow />}</View>");
  rule.invalid(
    "rejects a leaking account field",
    "<View>{account?.email && <SettingsRow />}</View>",
  );
  rule.invalid("rejects raw text in arrays", "<View>{[<SettingsRow />, 0]}</View>");
  rule.invalid("rejects raw text in fragments", '<View><>{" "}</></View>');
  rule.invalid("rejects template strings", "<View><Text>Safe</Text>{`Count ${count}`}</View>");

  rule.valid(
    "allows comments on their own line",
    "<View>\n  <SignInSettingsRow />\n  {/* sign-in grants */}\n</View>",
  );
  rule.valid("allows a ternary guard", "<View>{signedIn ? <Account /> : null}</View>");
  rule.valid("allows a count comparison", "<View>{count > 0 ? <SettingsRow /> : null}</View>");
  rule.valid("allows a boolean guard", "<View>{count > 0 && <SettingsRow />}</View>");
  rule.valid("allows boolean coercion", "<View>{!!email && <SettingsRow />}</View>");
  rule.valid(
    "allows native text content",
    '<View><Text>{count} {email || "Signed out"}</Text></View>',
  );
  rule.valid("allows AppText content", "<View><AppText>Sign out</AppText></View>");
  rule.valid(
    "recognizes an aliased native Text import",
    'import { Text as NativeText } from "react-native"; const el = <View><NativeText>Sign out</NativeText></View>;',
  );
  rule.valid(
    "recognizes an aliased AppText import",
    'import { AppText as Label } from "./AppText"; const el = <View><Label>{email}</Label></View>;',
  );
  rule.valid(
    "ignores props",
    '<View accessibilityLabel={name || "Account"}><SettingsRow value={email} /></View>',
  );
  rule.valid("allows text fragments within Text", '<Text><>{" "}{0}</></Text>');
  rule.valid("allows absent children", "<View>{false}{null}{undefined}</View>");
});
