// @effect-diagnostics nodeBuiltinImport:off - Maintainer CLI for one explicitly admitted local startup profile.
import * as NodeFSP from "node:fs/promises";
import { profileWorkerStartup } from "./profile.ts";

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error("Usage: node cli.ts <startup-profile-input.json>");
const result = await profileWorkerStartup(JSON.parse(await NodeFSP.readFile(path, "utf8")));
process.stdout.write(`${JSON.stringify(result)}\n`);
