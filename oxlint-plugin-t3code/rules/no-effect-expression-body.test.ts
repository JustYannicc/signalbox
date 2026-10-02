import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-effect-expression-body", {
  filename: "fixture.tsx",
});

describe("t3code/no-effect-expression-body", () => {
  rule.valid(
    "allows block bodies",
    `useLayoutEffect(() => { ref.current?.scrollIntoView(); }, []);`,
  );

  rule.valid("allows returning a cleanup identifier", `useEffect(() => release, [release]);`);

  rule.valid(
    "allows returning a cleanup arrow",
    `useEffect(() => () => observer.disconnect(), [observer]);`,
  );

  rule.valid("ignores other hooks", `const value = useMemo(() => compute(a), [a]);`);

  rule.valid(
    "allows returning a subscription's unsubscribe",
    `useEffect(() => history.subscribe(onChange), [history]);`,
  );

  rule.invalid(
    "reports an assignment body",
    `useEffect(() => (ref.current = value), [value]);`,
    (output) => {
      assert.match(output, /Wrap the useEffect callback body/);
    },
  );

  rule.invalid(
    "reports an optional call body on useLayoutEffect",
    `useLayoutEffect(() => ref.current?.scrollIntoView({ block: "end" }), []);`,
    (output) => {
      assert.match(output, /destroy is not a function/);
    },
  );

  rule.invalid(
    "reports a focus call on React.useEffect",
    `React.useEffect(() => inputRef.current?.focus(), []);`,
    (output) => {
      assert.match(output, /Wrap the useEffect callback body/);
    },
  );
});
