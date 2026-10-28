#!/usr/bin/env bash
# Prints which CI areas a pull request's merge commit can affect, as GitHub step outputs.
# web: anything beyond the mobile app and agent notes. server: also excludes www and docs/,
# which www renders. Renames count both paths, so moving a file out of an area still runs it.
set -euo pipefail

files="$(git diff --no-renames --name-only HEAD^1 HEAD)"
web=false
server=false
while IFS= read -r file; do
  case "$file" in
    apps/mobile/package.json | apps/www/package.json) ;;
    .agents/* | .claude/* | apps/mobile/*) continue ;;
    apps/www/* | docs/*) web=true; continue ;;
    */*) ;;
    *.md) continue ;;
  esac
  web=true
  server=true
  break
done <<<"$files"
echo "web=$web"
echo "server=$server"
