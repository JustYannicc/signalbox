import {
  bootstrapBody,
  reconcileDeploy3Bootstraps,
  type Deploy3Bootstrap,
} from "./bootstrapRegistry.ts";
import * as Schema from "effect/Schema";
import {
  controlBody,
  reconcileDeploy3Controls,
  type Deploy3ControlEvent,
  type Deploy3ControlComment,
} from "./controlRegistry.ts";
import { readBoundedApiResponse } from "./httpResponse.ts";
import { boundedOperation } from "./platform.ts";
import {
  formatDeploy3PublicReceipt,
  type Deploy3PublicTeardownReceipt,
} from "./teardownReceipt.ts";

const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  user: Schema.Struct({ id: Schema.Number }),
});
const ROOT = "https://api.github.com/repos/JustYannicc/signalbox";
const ISSUE = "/issues/1070/comments";
export const RECEIPT_MARKER = "<!-- signalbox-deploy3-teardown-v1 ";

const decodeUnknownJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.Array(Comment));
const decodeComment = Schema.decodeUnknownSync(Comment);

export function deploy3RegistryApi(input: {
  readonly token: () => Promise<string>;
  readonly trustedWriterIds: readonly number[];
  readonly fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  async function request(path: string, body?: string): Promise<unknown> {
    return boundedOperation(async (signal) => {
      const token = await input.token();
      if (!token && body !== undefined)
        throw new Error("GitHub control write credential is unavailable");
      const response = await fetchImpl(ROOT + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "signalbox-deploy3-control",
          "x-github-api-version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body }),
        signal,
        redirect: "error",
        cache: "no-store",
      });
      if (response.status !== (body === undefined ? 200 : 201))
        throw new Error("GitHub control request was not confirmed");
      const bytes = await readBoundedApiResponse(response);
      return decodeUnknownJson(new TextDecoder().decode(bytes));
    }, 10_000);
  }
  async function comments(): Promise<readonly Deploy3ControlComment[]> {
    const all: Deploy3ControlComment[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 100; page++) {
      const rows = decodeJson(await request(`${ISSUE}?per_page=100&page=${page}`));
      for (const row of rows) {
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) {
          throw new Error("Incomplete or duplicate GitHub control inventory");
        }
        seen.add(row.id);
        all.push(row);
      }
      if (rows.length < 100) return all;
    }
    throw new Error("GitHub control inventory exceeded its bound");
  }
  async function post(body: string) {
    const created = decodeComment(await request(ISSUE, JSON.stringify({ body })));
    if (!input.trustedWriterIds.includes(created.user.id) || created.body !== body) {
      throw new Error("GitHub control writer or readback differed");
    }
    return created;
  }
  return {
    comments,
    async read() {
      const rows = await comments();
      return {
        comments: rows,
        bootstraps: reconcileDeploy3Bootstraps(rows, input.trustedWriterIds),
        controls: await reconcileDeploy3Controls(rows, input.trustedWriterIds),
      };
    },
    async appendBootstrap(value: Deploy3Bootstrap) {
      const created = await post(bootstrapBody(value));
      const readback = decodeComment(await request(`/issues/comments/${created.id}`));
      if (readback.body !== created.body || readback.user.id !== created.user.id)
        throw new Error("Bootstrap readback differed");
      return readback;
    },
    async append(event: Deploy3ControlEvent) {
      const created = await post(controlBody(event));
      const readback = decodeComment(await request(`/issues/comments/${created.id}`));
      if (readback.body !== created.body || readback.user.id !== created.user.id) {
        throw new Error("Durable control registration readback differed");
      }
      return readback;
    },
    async postReceipt(registrationSha256: string, receipt: Deploy3PublicTeardownReceipt) {
      if (!/^[a-f0-9]{64}$/.test(registrationSha256))
        throw new Error("Invalid teardown registration digest");
      return post(
        `${RECEIPT_MARKER}${registrationSha256} -->\n${formatDeploy3PublicReceipt(receipt)}`,
      );
    },
    receiptIsFinal(rows: readonly Deploy3ControlComment[], registrationSha256: string) {
      const marker = `${RECEIPT_MARKER}${registrationSha256} -->\n`;
      return rows.some(
        (row) =>
          input.trustedWriterIds.includes(row.user.id) &&
          row.body.startsWith(marker) &&
          row.body.includes("\nAbsence verified: yes.\n") &&
          row.body.includes("\nToken expiry: expired-verified,"),
      );
    },
  };
}
export type Deploy3RegistryApi = ReturnType<typeof deploy3RegistryApi>;
