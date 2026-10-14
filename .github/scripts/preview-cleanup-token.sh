#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
node --input-type=module -e "
  import { createHmac } from 'node:crypto';
  process.stdout.write(createHmac('sha256', process.env.CLOUDFLARE_API_TOKEN)
    .update('signalbox-preview-cleanup-v1')
    .digest('hex'));
"
