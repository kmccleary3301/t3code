#!/bin/sh
# Cross-platform release lifecycle smoke for macOS and Linux runners.
# The runner owns HOME and RUNNER_TEMP; native roots are asserted before and after
# the release install, while the T3 prefix remains disposable and profile-owned.
set -eu

fail() {
  printf '%s\n' "release lifecycle: $*" >&2
  exit 1
}

repository=${T3_LIFECYCLE_REPOSITORY:?T3_LIFECYCLE_REPOSITORY is required}
current_tag=${T3_LIFECYCLE_RELEASE_TAG:?T3_LIFECYCLE_RELEASE_TAG is required}
previous_tag=${T3_LIFECYCLE_PREVIOUS_TAG:?T3_LIFECYCLE_PREVIOUS_TAG is required}
native_root=${T3_LIFECYCLE_NATIVE_ROOT:?T3_LIFECYCLE_NATIVE_ROOT is required}
report_path=${T3_LIFECYCLE_REPORT:?T3_LIFECYCLE_REPORT is required}

case "$repository" in
  */*) ;;
  *) fail "invalid repository '$repository'" ;;
esac
case "$current_tag" in
  fork-v[0-9]* ) current_version=${current_tag#fork-v} ;;
  *) fail "current tag must be fork-vX.Y.Z" ;;
esac
case "$previous_tag" in
  fork-v[0-9]* ) previous_version=${previous_tag#fork-v} ;;
  *) fail "previous tag must be fork-vX.Y.Z" ;;
esac

root=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/t3-pi-omp-release-lifecycle
rm -rf "$root"
mkdir -p "$root/releases" "$root/reports" "$(dirname "$report_path")"
server_pid=
stop_server() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    j=0
    while kill -0 "$server_pid" 2>/dev/null && [ "$j" -lt 30 ]; do
      sleep 1
      j=$((j + 1))
    done
    if kill -0 "$server_pid" 2>/dev/null; then
      kill -9 "$server_pid" 2>/dev/null || true
    fi
    wait "$server_pid" 2>/dev/null || true
  fi
  server_pid=
}
cleanup() {
  stop_server
  rm -rf "$root"
}
trap cleanup EXIT HUP INT TERM

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

sha256_file() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1; exit }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1; exit }'
  else
    fail "sha256sum or shasum is required"
  fi
}

verify_checksum_entry() {
  file=$1
  sums=$2
  name=$3
  expected=$(awk -v target="$name" '$2 == target || $2 == ("./" target) { print $1; exit }' "$sums")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $name"
  actual=$(sha256_file "$file")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $name"
  printf '%s\n' "$actual"
}

fetch_release() {
  tag=$1
  destination=$2
  version=${tag#fork-v}
  base="https://github.com/$repository/releases/download/$tag"
  mkdir -p "$destination"
  curl -fsSL "$base/install.sh" -o "$destination/install.sh"
  curl -fsSL "$base/RELEASE-MANIFEST.json" -o "$destination/RELEASE-MANIFEST.json"
  curl -fsSL "$base/SHA256SUMS" -o "$destination/SHA256SUMS"
  installer_sha=$(verify_checksum_entry "$destination/install.sh" "$destination/SHA256SUMS" install.sh)
  manifest_sha=$(verify_checksum_entry "$destination/RELEASE-MANIFEST.json" "$destination/SHA256SUMS" RELEASE-MANIFEST.json)
  sh -n "$destination/install.sh"
  node - "$destination/RELEASE-MANIFEST.json" "$version" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const version = process.argv[3];
if (manifest.profile !== "pi-omp") throw new Error(`unexpected profile ${manifest.profile}`);
if (manifest.clientVersion !== version) throw new Error(`unexpected version ${manifest.clientVersion}`);
if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.some((asset) => asset.kind === "cli")) {
  throw new Error("manifest has no CLI artifact");
}
NODE
  printf '%s\t%s\t%s\n' "$tag" "$installer_sha" "$manifest_sha" >> "$root/release-hashes.tsv"
}

fetch_release "$previous_tag" "$root/releases/$previous_tag"
fetch_release "$current_tag" "$root/releases/$current_tag"

pi_state="$native_root/.pi/agent/config.json"
omp_state="$native_root/.omp/agent/agent.db"
mkdir -p "$(dirname "$pi_state")" "$(dirname "$omp_state")"
printf '%s\n' 'lifecycle-preservation-pi' > "$pi_state"
printf '%s\n' 'lifecycle-preservation-omp' > "$omp_state"
pi_before=$(sha256_file "$pi_state")
omp_before=$(sha256_file "$omp_state")

run_installer() {
  tag=$1
  prefix=$2
  version=${tag#fork-v}
  sh "$root/releases/$tag/install.sh" \
    --profile pi-omp \
    --release-base-url "https://github.com/$repository/releases/download/$tag" \
    --version "$version" \
    --prefix "$prefix"
}

assert_version() {
  prefix=$1
  expected=$2
  [ -x "$prefix/bin/t3-pi-omp" ] || fail "installed CLI is missing at $prefix"
  version_output=$("$prefix/bin/t3-pi-omp" --version 2>&1) || fail "--version failed for $expected"
  case "$version_output" in
    *"$expected"*) ;;
    *) fail "expected version $expected, got: $version_output" ;;
  esac
  help_output=$("$prefix/bin/t3-pi-omp" --help 2>&1) || fail "--help failed for $expected"
  case "$help_output" in
    *"Run the T3 Code server"*) ;;
    *) fail "help output did not describe the server command" ;;
  esac
}

prefix="$root/prefix"
run_installer "$previous_tag" "$prefix"
assert_version "$prefix" "$previous_version"
run_installer "$current_tag" "$prefix"
assert_version "$prefix" "$current_version"
[ "$(cat "$prefix/.previous-version")" = "$previous_version" ] || fail "upgrade did not retain previous version"

port=38773
server_base="$root/server-home"
server_log="$root/server.log"
"$prefix/bin/t3-pi-omp" serve --port "$port" --base-dir "$server_base" --no-browser >"$server_log" 2>&1 &
server_pid=$!
ready=0
i=0
while [ "$i" -lt 60 ]; do
  if curl --max-time 5 -fsS "http://127.0.0.1:$port/.well-known/t3/environment" > "$root/environment.json" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$server_log" >&2 || true
    fail "server exited before readiness"
  fi
  i=$((i + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || { cat "$server_log" >&2 || true; fail "server readiness timed out"; }
node - "$root/environment.json" <<'NODE'
const fs = require("node:fs");
const descriptor = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof descriptor.environmentId !== "string" || descriptor.environmentId.length === 0) {
  throw new Error("environment descriptor has no environmentId");
}
NODE
stop_server

sh "$root/releases/$current_tag/install.sh" \
  --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/$current_tag" \
  --prefix "$prefix" \
  --rollback
assert_version "$prefix" "$previous_version"

bad_prefix="$root/bad-prefix"
set +e
sh "$root/releases/$current_tag/install.sh" \
  --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/fork-v99.99.99" \
  --version 99.99.99 \
  --prefix "$bad_prefix" >/dev/null 2>&1
bad_status=$?
set -e
[ "$bad_status" -ne 0 ] || fail "missing release unexpectedly succeeded"
[ ! -e "$bad_prefix" ] || fail "missing release mutated its prefix"

sh "$root/releases/$current_tag/install.sh" --profile pi-omp --prefix "$prefix" --uninstall
[ ! -e "$prefix" ] || fail "uninstall left the owned prefix"

[ "$(sha256_file "$pi_state")" = "$pi_before" ] || fail "Pi native state changed"
[ "$(sha256_file "$omp_state")" = "$omp_before" ] || fail "OMP native state changed"

node - "$report_path" "$root/release-hashes.tsv" "$current_tag" "$previous_tag" <<'NODE'
const fs = require("node:fs");
const [report, hashes, currentTag, previousTag] = process.argv.slice(2);
const releaseHashes = fs.readFileSync(hashes, "utf8").trim().split("\n").map((line) => {
  const [tag, installerSha256, manifestSha256] = line.split("\t");
  return { tag, installerSha256, manifestSha256 };
});
fs.writeFileSync(report, JSON.stringify({
  schemaVersion: 1,
  profile: "pi-omp",
  platform: process.platform,
  architecture: process.arch,
  currentTag,
  previousTag,
  checks: ["fresh-install", "upgrade", "version-help", "server-health", "rollback", "missing-release-no-mutation", "uninstall", "native-config-preservation"],
  releaseHashes,
}, null, 2) + "\n");
NODE
printf '%s\n' "POSIX release lifecycle passed for $current_tag on $(uname -s)/$(uname -m)"
