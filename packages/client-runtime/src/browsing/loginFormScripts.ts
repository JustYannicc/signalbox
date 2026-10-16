import type { SignInFillKind } from "@t3tools/contracts/signalboxSignIn";

/**
 * The in-page half of a device signing its tab in (#586): finding a login
 * form's current step and filling it. Fields are filled the way password
 * manager extensions do, with the input's own value setter plus `input` and
 * `change` events, from a script in the page.
 *
 * The scripts are plain source, injected as is: they can't import anything.
 */

export type LoginFormKinds = readonly [SignInFillKind, ...Array<SignInFillKind>];

/** A login form's current step, as the page reported it. */
export interface LoginForm {
  readonly origin: string;
  readonly path: string;
  readonly kinds: LoginFormKinds;
}

/**
 * The page's field finder, shared by detection and filling. Conservative on
 * purpose: a sign-up or change-password form (a new password, or two),
 * an email box that isn't a login's, or a field already typed into is left
 * alone, since filling the wrong form is worse than filling none.
 */
const FIELDS = `
  var shown = function (el) {
    if (el.disabled || el.readOnly || el.type === "hidden") return false;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return el.getClientRects().length > 0;
  };
  var complete = function (el) { return (el.getAttribute("autocomplete") || "").toLowerCase(); };
  var named = function (el) {
    return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" ").toLowerCase();
  };
  var inputs = Array.prototype.filter.call(document.querySelectorAll("input"), shown);
  var textual = function (el) { return ["text", "email", "tel", "number", ""].indexOf(el.type) >= 0; };
  var isUser = function (el, loose) {
    if (!textual(el) || el.type === "number") return false;
    // Alone, only a field marked as a login's username counts: newsletter boxes say "email" too.
    if (/\\b(username|webauthn)\\b/.test(complete(el))) return true;
    if (!loose) return false;
    return /\\bemail\\b/.test(complete(el)) || el.type === "email" ||
      /(user|login|e-?mail|account|identifier)/.test(named(el));
  };
  var isCode = function (el) {
    if (!textual(el) || el.type === "email") return false;
    if (/one-time-code/.test(complete(el))) return true;
    var name = named(el);
    // Zip, promo and gift card boxes say "code" too; a login's code box is short and numeric.
    if (/(zip|postal|post.?code|promo|coupon|voucher|gift|discount|search|country|area)/.test(name)) return false;
    var numeric = el.inputMode === "numeric" || el.type === "tel" || el.type === "number" ||
      (el.maxLength >= 1 && el.maxLength <= 8);
    return numeric && /(otp|totp|2fa|mfa|one.?time|authenticator|verification|security.?code|passcode|\\bcode\\b)/.test(name);
  };
  var passwords = inputs.filter(function (el) { return el.type === "password"; });
  var fresh = passwords.filter(function (el) { return /new-password/.test(complete(el)); });
  var form = null;
  if (fresh.length === 0 && passwords.length === 1) {
    var password = passwords[0];
    // The username nearest before the password, in its form when it has one.
    var user = inputs.filter(function (el) {
      return el !== password && isUser(el, true) && el.form === password.form &&
        (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }).pop() || null;
    form = { kinds: user && !user.value ? ["username", "password"] : ["password"], user: user, password: password, code: [] };
    if (password.value) form = null;
  } else if (passwords.length === 0) {
    var codes = inputs.filter(isCode);
    var boxes = codes.length > 1 && codes.every(function (el) { return el.maxLength === 1; });
    var code = boxes ? codes : codes.slice(0, 1);
    var userOnly = inputs.filter(function (el) { return isUser(el, false); })[0] || null;
    if (code.length > 0 && code.every(function (el) { return !el.value; })) {
      form = { kinds: ["totp"], user: null, password: null, code: code };
    } else if (code.length === 0 && userOnly && !userOnly.value) {
      form = { kinds: ["username"], user: userOnly, password: null, code: [] };
    }
  }
`;

/** Finds the page's login form step: JSON for `parseLoginForm`, or null without one. */
export const findLoginFormScript = `(function () {
  if (window.top !== window) return null;
  try {
    ${FIELDS}
    if (!form) return null;
    return JSON.stringify({ origin: location.origin, path: location.pathname, kinds: form.kinds });
  } catch (error) {
    return null;
  }
})()`;

/** What filling did: `filled` (and submitted), `moved` (the page left `origin`), `missing` (the form went away). */
export type FillResult = "filled" | "moved" | "missing";

/** The values for one step; the script refuses any page that isn't at `origin`. */
export function fillLoginFormScript(input: {
  readonly origin: string;
  readonly username?: string;
  readonly password?: string;
  readonly totp?: string;
}): string {
  return `(function () {
  if (window.top !== window) return "moved";
  if (location.origin !== ${JSON.stringify(input.origin)}) return "moved";
  ${FIELDS}
  if (!form) return "missing";
  var values = ${JSON.stringify({ username: input.username, password: input.password, totp: input.totp })};
  var put = function (el, value) {
    el.focus();
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  var last = null;
  if (form.user && values.username !== undefined) { put(form.user, values.username); last = form.user; }
  if (form.password && values.password !== undefined) { put(form.password, values.password); last = form.password; }
  if (form.code.length > 0 && values.totp !== undefined) {
    if (form.code.length === 1) put(form.code[0], values.totp);
    else form.code.forEach(function (el, index) { put(el, values.totp.charAt(index)); });
    last = form.code[form.code.length - 1];
  }
  values = null;
  if (!last) return "missing";
  var field = last;
  setTimeout(function () {
    var owner = field.form;
    var submits = function (scope) {
      return Array.prototype.filter.call(scope.querySelectorAll("button, input[type=submit]"), function (el) {
        var label = el.textContent || el.value || "";
        // "Continue with Google" is another way in, not this form's button.
        return el.type === "submit" && shown(el) && !/\\bwith\\b/i.test(label) &&
          /(sign.?in|log.?in|next|continue|verify|submit)/i.test(label);
      })[0];
    };
    // A form's own button, else the nearest one around the field: never a header's or a banner's.
    var button = owner ? submits(owner) : undefined;
    for (var node = field.parentElement, depth = 0; !owner && !button && node && depth < 6; node = node.parentElement, depth++) {
      button = submits(node);
    }
    if (button) button.click();
    else if (owner && owner.requestSubmit) owner.requestSubmit();
  }, 150);
  return "filled";
})()`;
}

const KINDS = new Set<string>(["username", "password", "totp"]);

/** The page's report of its login form, if it is one; pages are untrusted, so anything else is dropped. */
export function parseLoginForm(raw: unknown): LoginForm | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const { origin, path, kinds } = value as Record<string, unknown>;
  if (typeof origin !== "string" || typeof path !== "string" || !Array.isArray(kinds)) return null;
  const known = kinds.filter((kind): kind is SignInFillKind => KINDS.has(kind as string));
  const [first, ...rest] = known;
  if (first === undefined || known.length !== kinds.length) return null;
  return { origin, path, kinds: [first, ...rest] };
}
