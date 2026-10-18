import { DurableObject } from "cloudflare:workers";

import { runBunShimProof } from "./bunProof.ts";
import type { BunFileHost, BunFileTarget } from "../BunShim.ts";

export class BunShimProof extends DurableObject {
  override async fetch(request: Request) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS proof_files (path TEXT PRIMARY KEY, data BLOB NOT NULL)");
    const read = (path: BunFileTarget) => {
      const row = sql
        .exec<{ data: ArrayBuffer }>("SELECT data FROM proof_files WHERE path = ?", String(path))
        .toArray()[0];
      if (!row) throw Object.assign(new Error("No such file"), { code: "ENOENT" });
      return new Uint8Array(row.data);
    };
    const stat = (path: BunFileTarget) => ({
      size: read(path).length,
      isFile: () => true,
      isDirectory: () => false,
    });
    const host: BunFileHost = {
      readFile: async (path) => read(path),
      writeFile: async (path, data) => {
        sql.exec("INSERT OR REPLACE INTO proof_files VALUES (?, ?)", String(path), data);
      },
      stat: async (path) => stat(path),
      statSync: stat,
    };
    if (new URL(request.url).pathname === "/persistence") {
      const previous = await host.readFile("/proof.txt").catch(() => null);
      return Response.json({
        previous: previous === null ? null : new TextDecoder().decode(previous),
      });
    }
    return Response.json(await runBunShimProof(host));
  }
}

export default {
  fetch(request: Request, env: { PROOF: DurableObjectNamespace }) {
    return env.PROOF.get(env.PROOF.idFromName("bun-shim-proof")).fetch(request);
  },
};
