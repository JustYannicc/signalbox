# Signalbox demo deploy

Public URL: `https://signalbox-demo.justyannicc.com`. The friend gets a one-time pairing link:
`https://signalbox-demo.justyannicc.com/pair#token=<token>`.

## How it's wired

The Dokploy host (`<server-host>`, public IP `<server-ip>`, x86_64) has ports 80/443 closed
publicly. Every Dokploy service there is tailnet-only, so a public URL goes through a Cloudflare
Tunnel. It follows the usual pattern for that host: a locally built image with
`pull_policy: never`, plus a `cloudflared` sidecar that uses `TUNNEL_TOKEN`.

```
friend -> Cloudflare edge (TLS, WS) -> tunnel -> cloudflared -> http://signalbox:3773 (internal net)
```

There's no Dokploy domain, Traefik route, or Let's Encrypt cert. TLS ends at Cloudflare.
The `justyannicc.com` zone already has WebSockets on.

Files here:

- `Dockerfile` + `Dockerfile.dockerignore`: the build context is the worktree, so uncommitted changes ship
- `compose.yml`: the Dokploy raw compose

Tested locally (arm64). The web app loads, pairing works, WS connects, and `terminal.open` is refused.

## Env vars

| Where                          | Var                                                                       | Value                                   |
| ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------- |
| Dokploy compose env            | `SIGNALBOX_IMAGE_TAG`                                                     | e.g. `20261001`                         |
| Dokploy compose env            | `CLOUDFLARE_TUNNEL_TOKEN`                                                 | from step 2                             |
| Dokploy compose env (optional) | `SIGNALBOX_LINK_SCOPES`                                                   | default `orchestration:read,relay:read` |
| Baked in image                 | `T3CODE_HOME=/home/node/signalbox`, `T3CODE_PORT=3773`, `T3CODE_MODE=web` |                                         |

Never set `VITE_HTTP_URL` / `VITE_WS_URL`. The build ignores every `.env*` file.

## 1. Build the image on the server (native amd64)

The SSH user can't reach the docker socket without sudo. Disk space on the server is
tight, so prune after the build.

```sh
WT=<path-to-worktree>
TAG=$(date +%Y%m%d%H%M)
ssh <server-host> 'rm -rf ~/signalbox-demo && mkdir -p ~/signalbox-demo/ctx ~/signalbox-demo/meta'
tar -C "$WT" --exclude=node_modules --exclude=.pnpm-store --exclude=.t3 --exclude=.repos \
  --exclude=.git --exclude=dist --exclude='.env*' --exclude=apps/mobile/ios --exclude=apps/mobile/android \
  -czf - . | ssh <server-host> 'tar -xzf - -C ~/signalbox-demo/ctx'
scp /tmp/signalbox-demo-deploy/Dockerfile /tmp/signalbox-demo-deploy/Dockerfile.dockerignore \
  <server-host>:~/signalbox-demo/meta/
ssh <server-host> "sudo docker build -f ~/signalbox-demo/meta/Dockerfile -t signalbox-demo:$TAG ~/signalbox-demo/ctx \
  && sudo docker builder prune -f && rm -rf ~/signalbox-demo/ctx"
```

(Alternative: `docker buildx build --platform linux/amd64 ...` on the Mac, then
`docker save signalbox-demo:$TAG | ssh <server-host> sudo docker load`. It's slower because of emulation.)

## 2. Cloudflare tunnel + DNS (personal account)

Account `<cf-account-id>`, zone `justyannicc.com` = `<cf-zone-id>`.
Run these against the Cloudflare API:

```js
// a) create a remotely managed tunnel
POST /accounts/{acct}/cfd_tunnel  { name: "signalbox-demo", config_src: "cloudflare" }   // -> result.id = TID
// b) ingress
PUT  /accounts/{acct}/cfd_tunnel/{TID}/configurations
     { config: { ingress: [
         { hostname: "signalbox-demo.justyannicc.com", service: "http://signalbox:3773" },
         { service: "http_status:404" } ] } }
// c) DNS
POST /zones/{zone}/dns_records
     { type: "CNAME", name: "signalbox-demo", content: "{TID}.cfargotunnel.com", proxied: true,
       comment: "Signalbox demo tunnel (Dokploy)" }
// d) connector token for cloudflared
GET  /accounts/{acct}/cfd_tunnel/{TID}/token     // -> result = CLOUDFLARE_TUNNEL_TOKEN
```

## 3. Dokploy (API)

Use a separate project so teardown can't touch other stacks on the host.

```js
project.projectCreate({ body: { name: "Signalbox Demo", description: "Public throwaway demo via CF tunnel" } })
// read its default environmentId: project.projectAll() -> find name "Signalbox Demo" -> environments[0].environmentId
compose.composeCreate({ body: { name: "Signalbox Demo", environmentId, composeType: "docker-compose",
                                composeFile: <compose.yml contents> } })          // -> composeId, appName
compose.composeUpdate({ body: { composeId, sourceType: "raw", composeFile: <compose.yml>,
  env: "SIGNALBOX_IMAGE_TAG=<TAG>\nCLOUDFLARE_TUNNEL_TOKEN=<token>" } })
compose.composeDeploy({ body: { composeId } })
```

## 4. Mint the shareable link

```sh
ssh <server-host> 'sudo docker exec $(sudo docker ps -qf "ancestor=signalbox-demo:<TAG>") signalbox-mint-link 7d'
# -> { "pairUrl": "https://signalbox-demo.justyannicc.com/pair#token=...", "scopes": [...] }
```

- Each link works once and gives one browser a 30-day session cookie. Mint one per device.
- Links and sessions live in the container's writable layer. A redeploy or container recreate
  wipes them and reseeds the demo, so mint a fresh link afterwards.
- The server log prints a startup `pairingUrl` with **admin** scopes and a `localhost` base.
  Don't share that one.
- Revoke: `docker exec <ctr> node /app/dist/bin.mjs auth pairing revoke <id> --base-dir /home/node/signalbox`.

Verify: `curl -s https://signalbox-demo.justyannicc.com/.well-known/t3/environment` returns JSON.
Then open the link and check the sidebar shows the 7 demo projects / 31 threads.

## Security posture

- No credentials in the image: no `.env`, no provider CLIs (codex/claude/gh/glab absent), no
  volumes, no host binds. Non-root (`node`, uid 1000), `cap_drop: ALL`, `no-new-privileges`,
  1 GB / 1 CPU / 256 pids.
- The app sits on an `internal: true` network. It has no internet egress and can't reach
  `dokploy-network`, the tailnet, or other stacks. Only cloudflared bridges out, and it points
  only at `signalbox:3773`.
- Terminals are gated by the `terminal:operate` scope. `signalbox-mint-link` never grants it
  (verified: `terminal.open` -> `EnvironmentAuthorizationError`).
- Default link scopes are read-only (`orchestration:read,relay:read`). Setting
  `SIGNALBOX_LINK_SCOPES=orchestration:read,orchestration:operate,review:write,relay:read` lets the
  friend dispatch commands. That includes `projects.writeFile` and process signals inside the
  container. No egress, so the blast radius stays in the throwaway container.

## Redeploy (after more UI work)

Rebuild with a new `TAG` (step 1), `composeUpdate` the env tag, then `composeDeploy`. Mint new links.

## Teardown

```js
compose.composeDelete({ body: { composeId, deleteVolumes: true } });
project.projectRemove({ body: { projectId } });
// Cloudflare
DELETE / zones / { zone } / dns_records / { recordId };
DELETE / accounts / { acct } / cfd_tunnel / { TID }; // after cloudflared is gone (0 connections)
```

```sh
ssh <server-host> 'sudo docker image rm signalbox-demo:<TAG>; rm -rf ~/signalbox-demo'
```
