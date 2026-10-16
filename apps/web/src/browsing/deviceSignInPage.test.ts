// @vitest-environment jsdom
import {
  findLoginFormScript,
  fillLoginFormScript,
  parseLoginForm,
} from "@t3tools/client-runtime/browsing/sign-in";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The in-page half of a device signing its tab in (#586), run in a real DOM:
 * which forms it fills, and that it fills and submits them the way a
 * password manager extension does.
 */

// jsdom has no layout; hidden inputs are the ones a test hides.
HTMLElement.prototype.checkVisibility = function (this: HTMLElement) {
  return !this.hidden && this.style.display !== "none";
};

const find = () => parseLoginForm(window.eval(findLoginFormScript));
const fill = (values: { username?: string; password?: string; totp?: string }) =>
  window.eval(fillLoginFormScript({ origin: location.origin, ...values })) as string;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

describe("finding a login form", () => {
  it("finds a username and password form", () => {
    document.body.innerHTML = `<form>
      <input type="email" name="email" autocomplete="username">
      <input type="password" name="password" autocomplete="current-password">
      <button>Sign in</button></form>`;
    expect(find()?.kinds).toEqual(["username", "password"]);
  });

  it("asks only for the password when the username is already there", () => {
    document.body.innerHTML = `<form>
      <input type="email" name="email" value="me@example.com">
      <input type="password" name="password"></form>`;
    expect(find()?.kinds).toEqual(["password"]);
  });

  it("finds each step of an identifier-first login", () => {
    document.body.innerHTML = `<form><input type="email" name="identifier" autocomplete="username"><button>Next</button></form>`;
    expect(find()?.kinds).toEqual(["username"]);
    document.body.innerHTML = `<form><input name="code" autocomplete="one-time-code" inputmode="numeric"></form>`;
    expect(find()?.kinds).toEqual(["totp"]);
  });

  it("leaves sign-up, change-password and newsletter forms alone", () => {
    document.body.innerHTML = `<form><input type="email" autocomplete="username">
      <input type="password" autocomplete="new-password"></form>`;
    expect(find()).toBeNull();
    document.body.innerHTML = `<form><input type="password"><input type="password"></form>`;
    expect(find()).toBeNull();
    document.body.innerHTML = `<form><input type="email" name="newsletter-email" placeholder="Your email"><button>Subscribe</button></form>`;
    expect(find()).toBeNull();
    document.body.innerHTML = `<input type="search" name="q">`;
    expect(find()).toBeNull();
    // A newsletter box marked as an email isn't a login's username.
    document.body.innerHTML = `<form><input type="email" autocomplete="email"><button>Subscribe</button></form>`;
    expect(find()).toBeNull();
  });

  it("never takes a checkout's zip, promo or gift card box for a login code", () => {
    for (const name of ["postal-code", "zipcode", "promo-code", "giftCardCode", "discount_code"]) {
      document.body.innerHTML = `<form><input name="${name}" inputmode="numeric" maxlength="6"><button>Place order</button></form>`;
      expect(find()).toBeNull();
    }
    document.body.innerHTML = `<form><input name="code" placeholder="Your code"></form>`;
    expect(find()).toBeNull();
  });

  it("pairs a formless password with the username just before it, not a footer's email", () => {
    document.body.innerHTML = `<div><input name="login" id="login"><input type="password" id="pw"></div>
      <footer><input type="email" name="newsletter"></footer>`;
    expect(find()?.kinds).toEqual(["username", "password"]);
    fill({ username: "me", password: "s3cret" });
    expect(document.querySelector<HTMLInputElement>("#login")!.value).toBe("me");
    expect(document.querySelector<HTMLInputElement>("[name=newsletter]")!.value).toBe("");
  });

  it("ignores hidden fields and a password someone already typed", () => {
    document.body.innerHTML = `<form><input type="password" hidden></form>`;
    expect(find()).toBeNull();
    document.body.innerHTML = `<form><input type="password" value="typed"></form>`;
    expect(find()).toBeNull();
  });
});

describe("filling a login form", () => {
  it("fills with input events and submits", () => {
    document.body.innerHTML = `<form>
      <input type="email" name="email" autocomplete="username">
      <input type="password" name="password"><button type="submit">Sign in</button></form>`;
    const events: Array<string> = [];
    const formElement = document.querySelector("form")!;
    formElement.addEventListener("input", (event) =>
      events.push((event.target as HTMLInputElement).name),
    );
    const submitted = vi.fn((event: Event) => event.preventDefault());
    formElement.addEventListener("submit", submitted);

    expect(fill({ username: "me@example.com", password: "s3cret" })).toBe("filled");
    expect(document.querySelector<HTMLInputElement>("[name=email]")!.value).toBe("me@example.com");
    expect(document.querySelector<HTMLInputElement>("[name=password]")!.value).toBe("s3cret");
    expect(events).toEqual(["email", "password"]);
    expect(submitted).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("presses the form's own sign-in button, not a show-password or social one", () => {
    document.body.innerHTML = `<form><input type="password" name="password">
      <button id="show">Show</button><button id="google">Continue with Google</button>
      <button id="go">Log in</button></form>`;
    const pressed: Array<string> = [];
    for (const button of document.querySelectorAll("button")) {
      button.addEventListener("click", (event) => {
        pressed.push(button.id);
        event.preventDefault();
      });
    }
    fill({ password: "s3cret" });
    vi.runAllTimers();
    expect(pressed).toEqual(["go"]);
  });

  it("puts a code split over single-digit boxes one digit per box", () => {
    document.body.innerHTML = `<form>${Array.from(
      { length: 6 },
      (_, index) => `<input name="otp-${index}" maxlength="1" inputmode="numeric">`,
    ).join("")}</form>`;
    expect(find()?.kinds).toEqual(["totp"]);
    expect(fill({ totp: "731205" })).toBe("filled");
    const digits = [...document.querySelectorAll("input")].map((input) => input.value).join("");
    expect(digits).toBe("731205");
  });

  it("refuses a page that moved to another site, and says when the form is gone", () => {
    document.body.innerHTML = `<form><input type="password"></form>`;
    expect(
      window.eval(fillLoginFormScript({ origin: "https://elsewhere.test", password: "s3cret" })),
    ).toBe("moved");
    expect(document.querySelector("input")!.value).toBe("");
    document.body.innerHTML = "";
    expect(fill({ password: "s3cret" })).toBe("missing");
  });
});
