# Signalbox prototype (reference)

The `prototype` branch is the clickable UI prototype: "display everything, logic later". Most surfaces run on fixture data. It is kept as a visual and interaction reference; real work happens on `main` through PRs, tracked as GitHub issues.

- `PLAN.md`: phased plan, decisions, and noted ideas.
- `inventory.md`: every prototype change by area, real vs mock, upstream conflict surface.
- `upstream-and-releases.md`: release pipeline, fork release setup, upstream compatibility strategy, telemetry.
- `cloud-runtime.md`: cloud architecture (Cloudflare Containers + Durable Objects), provider auth, identity.
- `demo-deploy/`: how the public demo was deployed (Dokploy + Cloudflare Tunnel).

Run the demo locally: `vp run dev:demo` (seeds `.t3/demo-home`).
