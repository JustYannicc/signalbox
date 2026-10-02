# syntax=docker/dockerfile:1.7
# Signalbox clickable demo: one container, built web served by the T3 server,
# seeded demo home, no credentials. Build context = the worktree (uncommitted
# changes ship). Ignore rules live in Dockerfile.dockerignore next to this file.
#
#   docker build -f /tmp/signalbox-demo-deploy/Dockerfile -t signalbox-demo:<tag> <worktree>

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    HUSKY=0
RUN npm install -g pnpm@11.10.0
WORKDIR /src
COPY . .
# Root + server + web + build-scripts closure only; mobile/desktop/marketing deps are skipped.
RUN pnpm install --frozen-lockfile --filter . --filter 't3...' --filter '@t3tools/web...' --filter '@t3tools/scripts...'
RUN cd apps/web && ../../node_modules/.bin/vp build
RUN cd apps/server && node scripts/cli.ts build
# Standalone server package with prod deps only (externals like node-pty).
RUN pnpm --filter t3 deploy --prod --legacy /out \
 && rm -rf /out/dist && cp -R apps/server/dist /out/dist
# Seed at the runtime path: git worktree metadata stores absolute paths.
RUN git config --global init.defaultBranch main \
 && node scripts/demo-environment.ts --reset --home-dir /home/node/signalbox \
 && mkdir -p /out/demo && pnpm dlx esbuild@0.28.2 scripts/lib/demo-database.ts --bundle --platform=node --format=esm '--external:node:*' --outfile=/out/demo/demo-database.mjs

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out /app
COPY --from=build --chown=node:node /home/node/signalbox /home/node/signalbox

# Starts the server, then restores the demo's "running" threads (boot orphans them).
COPY --chmod=755 <<'EOF' /usr/local/bin/signalbox-entrypoint
#!/bin/sh
set -eu
node /app/dist/bin.mjs --host 0.0.0.0 --port "$T3CODE_PORT" --base-dir "$T3CODE_HOME" \
  --no-browser &
server=$!
trap 'kill -TERM "$server" 2>/dev/null' TERM INT
i=0
until node -e "fetch('http://127.0.0.1:'+process.env.T3CODE_PORT+'/.well-known/t3/environment').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; do
  i=$((i+1)); [ "$i" -gt 60 ] && break; sleep 1
done
node -e "import('/app/demo/demo-database.mjs').then(m=>console.log('[signalbox] marked running threads:', m.markRunning(process.env.T3CODE_HOME, Date.now())))" || true
wait "$server"
EOF

# Mints a one-time pairing link. Scopes default to read-only browsing; terminal
# access (terminal:operate) is never granted.
#   docker exec <ctr> signalbox-mint-link [ttl]   e.g. 7d
COPY --chmod=755 <<'EOF' /usr/local/bin/signalbox-mint-link
#!/bin/sh
set -eu
json=$(node /app/dist/bin.mjs auth pairing create --base-dir "$T3CODE_HOME" \
  --base-url "$SIGNALBOX_PUBLIC_URL" --ttl "${1:-7d}" --label "signalbox-demo" --json)
printf '%s' "$json" | node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
let raw = ''; for await (const c of process.stdin) raw += c;
const issued = JSON.parse(raw);
const scopes = (process.env.SIGNALBOX_LINK_SCOPES || 'orchestration:read,relay:read')
  .split(',').map((s) => s.trim()).filter((s) => s && s !== 'terminal:operate');
const db = new DatabaseSync(process.env.T3CODE_HOME + '/userdata/state.sqlite', { timeout: 10000 });
db.prepare('UPDATE auth_pairing_links SET scopes = ? WHERE id = ?').run(JSON.stringify(scopes), issued.id);
db.close();
console.log(JSON.stringify({ id: issued.id, scopes, expiresAt: issued.expiresAt, pairUrl: issued.pairUrl }, null, 2));
"
EOF

USER node
WORKDIR /home/node/signalbox/workspace
ENV NODE_ENV=production \
    T3CODE_HOME=/home/node/signalbox \
    T3CODE_PORT=3773 \
    T3CODE_MODE=web \
    T3CODE_NO_BROWSER=true \
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false \
    T3CODE_OTEL_SDK_DISABLED=true \
    SIGNALBOX_PUBLIC_URL=http://localhost:3773 \
    SIGNALBOX_LINK_SCOPES=orchestration:read,relay:read
RUN mkdir -p /home/node/signalbox/workspace
EXPOSE 3773
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.T3CODE_PORT+'/.well-known/t3/environment').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/signalbox-entrypoint"]
