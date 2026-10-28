#!/usr/bin/env bash
# Prints which CI areas a pull request's merge commit can affect, as GitHub step outputs.
# web: anything beyond the mobile app and agent notes. e2e: web, minus the worker and server
# adapters, which the browser never loads. server: web, minus www and docs/, which www renders.
# native: the desktop app and the host-computer code its native tests exercise. compose: the
# Compose files the Postgres upgrade drill copies. Renames count both paths. Changes to CI itself,
# the lockfile, or anything unlisted (shared packages included) count as every area they could touch.
set -euo pipefail

files="$(git diff --no-renames --name-only HEAD^1 HEAD)"
web=false
e2e=false
server=false
native=false
compose=false
while IFS= read -r file; do
  case "$file" in
    .github/workflows/ci.yml | .github/scripts/changed-areas.sh | pnpm-lock.yaml | package.json)
      native=true
      compose=true
      ;;
    apps/desktop/* | scripts/pnpm*.mjs | packages/adapter-kit/* | \
      packages/adapters/src/host-computer* | packages/adapters/src/desktop-* | \
      packages/adapters/src/remote-desktop-* | packages/adapters/src/computer-support* | \
      packages/adapters/src/native-shell* | packages/adapters/src/sandbox-command-environment* | \
      packages/adapters/src/home.*)
      native=true
      ;;
    infra/compose/*) compose=true ;;
  esac
  case "$file" in
    apps/mobile/package.json | apps/www/package.json) ;;
    .agents/* | .claude/* | apps/mobile/*) continue ;;
    apps/www/* | docs/*) web=true; continue ;;
    apps/worker/* | packages/adapters/*) web=true; server=true; continue ;;
    */*) ;;
    *.md) continue ;;
  esac
  web=true
  e2e=true
  server=true
done <<<"$files"
echo "web=$web"
echo "e2e=$e2e"
echo "server=$server"
echo "native=$native"
echo "compose=$compose"
