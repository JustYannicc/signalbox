import * as NodeBuffer from "node:buffer";
import { authorityHost } from "./address.ts";
import { networkError } from "./errors.ts";

export function validateHeaderName(name: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw networkError(
      "ERR_INVALID_HTTP_TOKEN",
      `Header name must be a valid HTTP token ["${name}"]`,
    );
  }
}

export function createHeaders(
  options: Readonly<Record<string, unknown>>,
  host: string,
  port: number,
  protocol: "http" | "https",
): Headers {
  const headers = new Headers();
  const input = options.headers;
  if (Array.isArray(input)) {
    if (input.length % 2 !== 0)
      throw networkError("ERR_INVALID_ARG_VALUE", "The argument 'headers' is invalid");
    for (let index = 0; index < input.length; index += 2) {
      headers.append(String(input[index]), String(input[index + 1]));
    }
  } else if (typeof input === "object" && input !== null) {
    for (const [name, value] of Object.entries(input)) {
      validateHeaderName(name);
      for (const part of Array.isArray(value) ? value : [value]) headers.append(name, String(part));
    }
  }
  const defaultPort = protocol === "https" ? 443 : 80;
  const hostHeader = `${authorityHost(host)}${port === defaultPort ? "" : `:${port}`}`;
  if ((options.setHost ?? options.setDefaultHeaders ?? true) && !headers.has("host"))
    headers.set("host", hostHeader);
  if (typeof options.auth === "string" && !headers.has("authorization")) {
    headers.set(
      "authorization",
      `Basic ${NodeBuffer.Buffer.from(options.auth).toString("base64")}`,
    );
  }
  return headers;
}
