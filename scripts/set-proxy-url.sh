#!/bin/bash
# Point the Shopify App Proxy at the current dev tunnel and push the config.
#
# Why: `shopify app dev` updates the app URL on every restart but NOT the app
# proxy URL (known CLI limitation — Shopify/cli#990), so the storefront booking
# widget's /apps/booking/* calls break each time the tunnel changes.
#
# Usage:  ./scripts/set-proxy-url.sh https://your-tunnel.trycloudflare.com
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:?Usage: $0 <tunnel-or-host-url> (no trailing slash)}"
URL="${URL%/}"

sed -i '' "s|^url = \".*\"|url = \"$URL/proxy\"|" shopify.app.toml
grep -A1 "\[app_proxy\]" shopify.app.toml
shopify app deploy --force
echo "App proxy now targets $URL/proxy"
