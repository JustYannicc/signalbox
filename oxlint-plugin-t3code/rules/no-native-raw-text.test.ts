import { describe } from "vite-plus/test";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-native-raw-text", {
  filename: "fixture.tsx",
});
const customTextRule = createOxlintRuleHarness("t3code/no-native-raw-text", {
  filename: "fixture.tsx",
  ruleOptions: [{ textComponents: ["Label", "Typography.Caption"] }],
});

describe("t3code/no-native-raw-text", () => {
  rule.invalid("rejects JSX text", "<View>Sign out</View>");
  rule.invalid(
    "rejects the same-line space from #624",
    "<View><SignInSettingsRow /> {/* sign-in grants */}</View>",
  );
  rule.invalid("rejects an explicit space", '<View>{" "}</View>');
  rule.valid("allows an empty string ignored by React Native", '<View>{""}</View>');
  rule.invalid("rejects zero", "<View>{0}</View>");
  rule.invalid("rejects a negative number", "<View>{-1}</View>");
  rule.invalid("rejects a positive unary number", "<View>{+1}</View>");
  rule.invalid("rejects bigint zero", "<View>{0n}</View>");
  rule.invalid("rejects numeric addition", "<View>{1 + 1}</View>");
  rule.invalid("rejects nested numeric addition", "<View>{(1 * 2) + (-3)}</View>");
  rule.invalid("rejects subtraction", "<View>{value - 1}</View>");
  rule.invalid("rejects multiplication", "<View>{value * 2}</View>");
  rule.invalid("rejects division", "<View>{value / 2}</View>");
  rule.invalid("rejects remainder", "<View>{value % 2}</View>");
  rule.invalid("rejects exponentiation", "<View>{value ** 2}</View>");
  rule.invalid("rejects left shift", "<View>{value << 1}</View>");
  rule.invalid("rejects right shift", "<View>{value >> 1}</View>");
  rule.invalid("rejects unsigned right shift", "<View>{value >>> 1}</View>");
  rule.invalid("rejects bitwise or", "<View>{value | 1}</View>");
  rule.invalid("rejects bitwise xor", "<View>{value ^ 1}</View>");
  rule.invalid("rejects bitwise and", "<View>{value & 1}</View>");
  rule.invalid("rejects bitwise not", "<View>{~0}</View>");
  rule.invalid("rejects numeric expressions in children props", "<View children={1 + 1} />");
  rule.invalid("rejects text through satisfies", '<View>{"Bad" satisfies string}</View>');
  rule.invalid(
    "rejects children props through satisfies",
    "<View children={0 satisfies number} />",
  );
  rule.invalid(
    "rejects nested transparent wrappers",
    "<View>{((0 satisfies number) as number)!}</View>",
  );
  rule.invalid("rejects a string children prop", '<View children="Bad" />');
  rule.invalid("rejects a numeric children prop", "<View children={0} />");
  rule.invalid("rejects a signed children prop", "<View children={-1} />");
  rule.invalid("rejects a guarded children prop", "<View children={count && <Row />} />");
  rule.invalid("rejects multiline nonbreaking space", "<View>\n\u00a0\n</View>");
  rule.invalid("rejects multiline em space", "<View>\n\u2003\n</View>");
  rule.invalid(
    "rejects text in a ternary branch",
    '<View>{signedIn ? <Account /> : "Signed out"}</View>',
  );
  rule.invalid("rejects guarded text", '<View>{signedIn && "Signed in"}</View>');
  rule.invalid("rejects a leaking count", "<View>{count && <SettingsRow />}</View>");
  rule.invalid(
    "rejects boolean identifiers without type information",
    "const flag: boolean = false; const el = <View>{flag && <Row />}</View>;",
  );
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
    "allows boolean coercion through as",
    "<View>{(!!count as boolean) && <Row />}</View>",
  );
  rule.valid(
    "allows boolean coercion through satisfies",
    "<View>{(!!count satisfies boolean) && <Row />}</View>",
  );
  rule.valid("allows boolean coercion through non-null", "<View>{(!!count)! && <Row />}</View>");
  rule.valid(
    "allows native text content",
    '<View><Text>{count} {email || "Signed out"}</Text></View>',
  );
  rule.valid("allows AppText content", "<View><AppText>Sign out</AppText></View>");
  rule.valid("allows plain multiline indentation", "<View> \n\t <Row />\r\n </View>");
  rule.valid("allows named fragments within Text", "<Text><Fragment>Safe</Fragment></Text>");
  rule.valid(
    "allows React.Fragment within Text",
    "<Text><React.Fragment>Safe</React.Fragment></Text>",
  );
  rule.valid(
    "allows an imported fragment alias within Text",
    'import { Fragment as Group } from "react"; const el = <Text><Group>Safe</Group></Text>;',
  );
  rule.valid(
    "allows namespace native Text",
    'import * as RN from "react-native"; const el = <RN.Text>Safe</RN.Text>;',
  );
  rule.valid("allows Text children props", '<Text children="Safe" />');
  rule.valid("allows element children props", "<View children={<Text>Safe</Text>} />");
  rule.valid("allows empty children props", '<View children="" />');
  rule.valid(
    "allows an element-only nullish fallback",
    "<View>{(cond ? <A /> : null) ?? <B />}</View>",
  );
  rule.invalid("rejects raw text through named fragments", "<View><Fragment>Bad</Fragment></View>");
  rule.invalid(
    "rejects raw text through a fragment children prop",
    "<View children={<Fragment>Bad</Fragment>} />",
  );
  customTextRule.valid("allows configured text wrappers", "<Label>Safe</Label>");
  customTextRule.valid(
    "allows configured member text wrappers",
    '<Typography.Caption children="Safe" />',
  );
  rule.invalid("rejects unconfigured text wrappers", "<Label>Bad</Label>");
  rule.valid(
    "recognizes an aliased native Text import",
    'import { Text as NativeText } from "react-native"; const el = <View><NativeText>Sign out</NativeText></View>;',
  );
  rule.valid(
    "recognizes an aliased AppText import",
    'import { AppText as Label } from "./AppText"; const el = <View><Label>{email}</Label></View>;',
  );
  rule.valid(
    "recognizes a native Text alias imported after JSX",
    'const el = <NativeText>Safe</NativeText>; import { Text as NativeText } from "react-native";',
  );
  rule.valid(
    "recognizes a native namespace imported after JSX",
    'const el = <RN.Text>Safe</RN.Text>; import * as RN from "react-native";',
  );
  rule.valid(
    "recognizes an AppText alias imported after JSX",
    'const el = <Label>Safe</Label>; import { AppText as Label } from "./AppText";',
  );
  rule.valid(
    "recognizes a fragment alias imported after JSX",
    'const el = <Text><Group>Safe</Group></Text>; import { Fragment as Group } from "react";',
  );
  rule.valid(
    "recognizes a React namespace imported after JSX",
    'const el = <Text><R.Fragment>Safe</R.Fragment></Text>; import * as R from "react";',
  );
  rule.valid(
    "recognizes a React default import after JSX",
    'const el = <Text><R.Fragment>Safe</R.Fragment></Text>; import R from "react";',
  );
  rule.valid(
    "ignores props",
    '<View accessibilityLabel={name || "Account"}><SettingsRow value={email} /></View>',
  );
  rule.valid("allows text fragments within Text", '<Text><>{" "}{0}</></Text>');
  rule.valid("allows absent children", "<View>{false}{null}{undefined}</View>");
});
