import { describe } from "@effect/vitest";

import { createRuleHarness } from "../test/harness.ts";

const rule = createRuleHarness("signalbox/no-effect-expression-body");

describe("no-effect-expression-body", () => {
  rule.valid(
    "allows block bodies",
    `useLayoutEffect(() => { ref.current?.scrollIntoView(); }, []);`,
  );
  rule.valid("allows cleanup identifiers", `useEffect(() => release, [release]);`);
  rule.valid("allows cleanup functions", `useEffect(() => () => observer.disconnect(), []);`);
  rule.valid("allows subscriptions", `useEffect(() => history.subscribe(onChange), [history]);`);
  rule.valid("allows native dismissal", `useEffect(() => Keyboard.dismiss(), []);`);
  rule.valid("allows other hooks", `useMemo(() => element.focus(), []);`);
  rule.valid("allows methods outside effects", `const focus = () => element.focus();`);
  rule.valid("allows unknown return types", `useEffect(() => start(), []);`);
  rule.invalid("rejects assignments", `useEffect(() => (ref.current = value), [value]);`);
  rule.invalid(
    "rejects optional DOM calls",
    `useLayoutEffect(() => ref.current?.scrollIntoView(), []);`,
  );
  rule.invalid("rejects optional methods", `React.useEffect(() => el.scrollTo?.(0, 0), []);`);
  rule.invalid("rejects qualified hooks", `React.useEffect(() => input.focus(), []);`);
  rule.invalid("rejects insertion effects", `useInsertionEffect(() => ({ active: true }), []);`);
  rule.invalid("rejects await", `useEffect(async () => await start(), []);`);
  rule.invalid("rejects new", `useEffect(() => new Observer(), []);`);
  rule.invalid("rejects updates", `useEffect(() => count++, []);`);
  rule.invalid("rejects literals", `useEffect(() => 42, []);`);
  rule.invalid("rejects templates", "useEffect(() => `text`, []);");
  rule.invalid("rejects arrays", `useEffect(() => [], []);`);
  rule.invalid("unwraps assertions", `useEffect(() => (input.focus() as unknown), []);`);
  rule.invalid("unwraps callbacks", `useEffect((() => input.focus()) as EffectCallback, []);`);
  rule.invalid(
    "checks static computed names",
    `React["useEffect"](() => el["scrollIntoView"](), []);`,
  );
  rule.valid("ignores dynamic computed names", `React[hook](() => el[method](), []);`);
  rule.invalid(
    "covers every known DOM method",
    `
      useEffect(() => el.scrollIntoView(), []);
      useEffect(() => el.scrollTo(), []);
      useEffect(() => el.scrollBy(), []);
      useEffect(() => el.scroll(), []);
      useEffect(() => el.focus(), []);
      useEffect(() => el.blur(), []);
      useEffect(() => el.click(), []);
      useEffect(() => el.select(), []);
      useEffect(() => el.play(), []);
      useEffect(() => el.pause(), []);
      useEffect(() => el.requestFullscreen(), []);
      useEffect(() => el.exitFullscreen(), []);
      useEffect(() => el.showModal(), []);
      useEffect(() => el.requestPointerLock(), []);
    `,
    14,
  );
});
