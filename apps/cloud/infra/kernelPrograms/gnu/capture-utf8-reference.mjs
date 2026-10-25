import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// The image pins glibc, GNU sed 4.9, GNU grep 3.8 and Linux Bash 5.2.
const image = "node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0";
const corpus = JSON.parse(
  NodeFS.readFileSync(new URL("./utf8-corpus.json", import.meta.url), "utf8"),
);
const program = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const corpus = JSON.parse(fs.readFileSync(0, "utf8"));
const forced = {NO_COLOR:"1", TERM:"dumb", LANG:"C.UTF-8", LC_CTYPE:"C.UTF-8", LC_ALL:"C.UTF-8", COLORTERM:"", PAGER:"cat", GIT_PAGER:"cat", GH_PAGER:"cat", CODEX_CI:"1"};
const results = [];
for (const locale of ["C.UTF-8", "C.utf8"]) {
  const env = {...forced, LANG:locale, LC_CTYPE:locale, LC_ALL:locale};
  const charmap = spawnSync("/usr/bin/locale", ["charmap"], {env});
  if (charmap.status !== 0 || charmap.stderr.length || charmap.stdout.toString().trim() !== "UTF-8") throw Error("Locale unavailable: " + locale);
  for (const entry of corpus) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "signalbox-gnu-utf8-"));
    try {
      fs.writeFileSync(path.join(cwd, "input"), Buffer.from(entry.inputHex, "hex"));
      const result = spawnSync("/usr/bin/" + entry.program, entry.args, {cwd, env, argv0:entry.program});
      if (result.error || result.signal || result.status === null) throw result.error ?? Error("Reference did not exit");
      const files = Object.fromEntries(fs.readdirSync(cwd).sort().map(name=>[name,fs.readFileSync(path.join(cwd,name)).toString("hex")]));
      results.push({name:entry.name, locale, stdoutHex:result.stdout.toString("hex"), stderrHex:result.stderr.toString("hex"), exitCode:result.status, files});
    } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
  }
}
const version = name => spawnSync("/usr/bin/" + name,["--version"],{env:forced}).stdout.toString().split("\n")[0];
process.stdout.write(JSON.stringify({platform:process.platform, architecture:process.arch, kernel:os.release(), versions:{sed:version("sed"),grep:version("grep"),bash:version("bash")}, results},null,2)+"\n");
`;
const result = NodeChildProcess.spawnSync(
  "docker",
  ["run", "--rm", "-i", "--network", "none", image, "node", "-e", program],
  {
    input: JSON.stringify(corpus),
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (result.error || result.status !== 0)
  throw new Error(result.stderr.toString(), { cause: result.error });
const captured = JSON.parse(result.stdout);
if (captured.platform !== "linux") throw new Error("GNU reference must run on Linux");
const output = process.argv[2] ?? new URL("./utf8-reference.json", import.meta.url);
NodeFS.writeFileSync(output, `${JSON.stringify({ image, ...captured }, null, 2)}\n`);
console.log(`${captured.results.length} Linux GNU reference results written`);
