# Computer boxd proof

The manual **Computer boxd proof** workflow runs a reviewed candidate against a
disposable Worker, Durable Object and real boxd VMs. Only the repository owner can
dispatch it from main. Pass the full reviewed commit SHA as sourceCommit; it
must descend from the main commit running the workflow. The candidate must include
apps/cloud/infra/computerBoxdProof/run.ts.

The protected cloud-preview environment supplies Cloudflare deployment
credentials. The repository's BOXD_API_KEY deploy secret supplies the provider
credential through Alchemy's Config.Redacted binding. Never put credentials in
workflow inputs, command arguments, source files or evidence.

The workflow downloads the existing hash-pinned kernel program release inputs.
Its runner owns the unique deployment stage and VM names, and records ownership
before allocation. It must confirm provider cleanup before destroying the Worker
that owns recovery. The final step retries interrupted cleanup using the exact
stage file. The recovery file stays in the job temporary directory and is never
uploaded. If recovery fails, keep the stage deployed and follow the safe failure
receipt to recover its owned resources.

The runner writes a safe receipt before deployment and updates it during recovery,
including failures. Both proof and recovery receipts are uploaded. They record
the candidate, unique stage, owned VM names, checks and cleanup state without
credentials, endpoints or command configuration. This workflow enables proof
execution. A successful run establishes only the cases recorded in that receipt.
The proof source's Bases and revision backing are test adapters, separate from
production Bases and Artifacts wiring.

For the local workerd pass, build the command Runner from `apps/server` with
`node runner-command.config.ts`, then run
`node apps/cloud/infra/computerBoxdProof/local.ts --program-dir DIR --stage-file FILE --output FILE`
from the repository root. Use a clean, reviewed commit and supply `BOXD_API_KEY`
through the process environment. The local pass needs `cloudflared` for the VM's
Runner callback; its endpoint stays out of receipts. It keeps SQLite ownership
state beside the stage file. Recover an interrupted local pass with the same
commit and `local.ts --recover-stage-file FILE --output NEW_FILE`.

Both passes compare a real Bash child Dynamic Worker with the same command over
the real VM Runner socket, including binary streams, argv0, cwd, environment and
exit status. The VM pass forks one run-owned prepared source and applies the
result into an already-open kernel inode. This covers the proof's one-file
workspace adapter; it does not establish a general native mount or production
Bases lifecycle.
