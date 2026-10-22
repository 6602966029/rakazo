#!/usr/bin/env bash
# check-image.sh against a fake Docker CLI that exports a prepared filesystem; no daemon.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$scratch/bin"
cat >"$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  create) echo fake-container ;;
  export) [[ -z "${FAIL_EXPORT:-}" ]] && tar -c -C "$IMAGE_ROOT" app ;;  # no ./ prefix, like docker
  rm) ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$scratch/bin/docker"

key_body="$(printf 'A%.0s' {1..64})"
# A clean image: a header in bundled code, third-party fixtures, and example env files.
image() {
  local dir="$scratch/$1"
  mkdir -p "$dir/app/apps/api/dist" "$dir/app/node_modules/pkg/test" "$dir/app/infra/compose"
  printf 'const h = "-----BEGIN PRIVATE KEY-----\\n";\n' >"$dir/app/apps/api/dist/index.js"
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n' "$key_body" >"$dir/app/node_modules/pkg/test/key.pem"
  touch "$dir/app/node_modules/pkg/.env" "$dir/app/.env.example" "$dir/app/infra/compose/.env.images.example"
  echo "$dir"
}
check() { PATH="$scratch/bin:$PATH" IMAGE_ROOT="$1" bash "$root/check-image.sh" example/app:test 2>&1; }

clean="$(image clean)"
check "$clean" >/dev/null || fail "a clean image was rejected: $(check "$clean")"
FAIL_EXPORT=1 check "$clean" >/dev/null && fail "a failed export passed the check"

for case in env git key-file key-body; do
  dir="$(image "$case")"
  case "$case" in
    env) touch "$dir/app/.env.production" ;;
    git) mkdir -p "$dir/app/.git" && touch "$dir/app/.git/HEAD" ;;
    key-file) touch "$dir/app/deploy.pem" ;;
    key-body) printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\n%s\n' "$key_body" >"$dir/app/notes.txt" ;;
  esac
  if output="$(check "$dir")"; then
    fail "$case: an image with a secret passed"
  fi
  grep -q "must not ship" <<<"$output" || fail "$case: unexpected output: $output"
done

echo "check-image smoke passed"
