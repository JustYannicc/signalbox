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
stage file. A retained stage file means cleanup still needs recovery; keep the
stage deployed and follow the runner's failure receipt.

The uploaded receipt records the candidate, checks and confirmed cleanup without
credentials, endpoints or command configuration. This workflow enables proof
execution. A successful run establishes only the cases recorded in that receipt.
The proof source's Bases and revision backing are test adapters, separate from
production Bases and Artifacts wiring.
