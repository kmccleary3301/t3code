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
desktop_mount=
pi_state=
omp_state=
pi_state_backup=
omp_state_backup=
pi_state_existed=0
omp_state_existed=0
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
detach_desktop_mount() {
  if [ -n "${desktop_mount:-}" ]; then
    hdiutil detach "$desktop_mount" >/dev/null 2>&1 || hdiutil detach -force "$desktop_mount" >/dev/null 2>&1 || true
    rm -rf "$desktop_mount" >/dev/null 2>&1 || true
    desktop_mount=
  fi
}
restore_native_state() {
  state_path=$1
  backup_path=$2
  existed=$3
  [ -n "$state_path" ] || return 0
  if [ "$existed" -eq 1 ]; then
    cp -p "$backup_path" "$state_path" 2>/dev/null || true
  else
    rm -f "$state_path" 2>/dev/null || true
  fi
}
cleanup() {
  stop_server
  detach_desktop_mount
  restore_native_state "$pi_state" "$pi_state_backup" "$pi_state_existed"
  restore_native_state "$omp_state" "$omp_state_backup" "$omp_state_existed"
  rm -rf "$root" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

os_name=$(uname -s)
case "$os_name" in
  Darwin)
    host_platform=darwin
    command -v hdiutil >/dev/null 2>&1 || fail "hdiutil is required for the macOS desktop smoke"
    command -v plutil >/dev/null 2>&1 || fail "plutil is required for the macOS desktop smoke"
    command -v find >/dev/null 2>&1 || fail "find is required for the macOS desktop smoke"
    ;;
  Linux)
    host_platform=linux
    command -v find >/dev/null 2>&1 || fail "find is required for the Linux desktop smoke"
    ;;
  *) fail "unsupported operating system '$os_name'" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) host_arch=arm64 ;;
  x86_64|amd64) host_arch=x64 ;;
  *) fail "unsupported architecture '$(uname -m)'" ;;
esac

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
  node - "$destination/RELEASE-MANIFEST.json" "$version" "$host_platform" "$host_arch" <<'NODE'
const fs = require("node:fs");
const [manifestPath, version, platform, arch] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.profile !== "pi-omp") throw new Error(`unexpected profile ${manifest.profile}`);
if (manifest.clientVersion !== version) throw new Error(`unexpected version ${manifest.clientVersion}`);
if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.some((asset) => asset.kind === "cli")) {
  throw new Error("manifest has no CLI artifact");
}
const extension = platform === "darwin" ? /\.dmg$/iu : /\.appimage$/iu;
if (!manifest.artifacts.some((asset) =>
  asset.kind === "desktop" && asset.platform === platform && asset.arch === arch &&
  typeof asset.path === "string" && extension.test(asset.path))) {
  throw new Error(`manifest has no ${platform}-${arch} desktop artifact`);
}
NODE
  printf '%s\t%s\t%s\n' "$tag" "$installer_sha" "$manifest_sha" >> "$root/release-hashes.tsv"
}

fetch_release "$previous_tag" "$root/releases/$previous_tag"
fetch_release "$current_tag" "$root/releases/$current_tag"
manifest_asset_details() {
  manifest=$1
  kind=$2
  node - "$manifest" "$kind" "$host_platform" "$host_arch" <<'NODE'
const fs = require("node:fs");
const [manifestPath, wanted, platform, arch] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const candidates = Array.isArray(manifest.artifacts)
  ? manifest.artifacts.filter((asset) =>
      asset && asset.kind === wanted &&
      (wanted !== "desktop" || (asset.platform === platform && asset.arch === arch)))
  : [];
const asset = candidates.find((candidate) => typeof candidate.path === "string");
if (!asset) throw new Error(`manifest has no ${wanted} artifact for ${platform}-${arch}`);
process.stdout.write(`${asset.path}\t${asset.sha256 || ""}`);
NODE
}

run_bounded() {
  timeout_seconds=$1
  shift
  node - "$timeout_seconds" "$@" <<'NODE'
const { spawn } = require("node:child_process");
const timeoutSeconds = Number(process.argv[2]);
const command = process.argv[3];
const args = process.argv.slice(4);
const child = spawn(command, args, { stdio: "inherit" });
let settled = false;
const finish = (code, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (message) console.error(message);
  process.exit(code);
};
const timer = setTimeout(() => {
  child.kill("SIGKILL");
  finish(1, `${command} timed out after ${timeoutSeconds}s`);
}, timeoutSeconds * 1000);
child.on("error", (error) => finish(1, `${command} failed to start: ${error.message}`));
child.on("exit", (code, signal) => finish(code === 0 ? 0 : 1, code === 0 ? "" : `${command} exited with ${code ?? signal}`));
NODE
}

pi_state="$native_root/.pi/agent/config.json"
omp_state="$native_root/.omp/agent/agent.db"
pi_state_backup="$root/pi-state.before"
omp_state_backup="$root/omp-state.before"
if [ -e "$pi_state" ] || [ -L "$pi_state" ]; then
  [ -f "$pi_state" ] || fail "Pi native state is not a regular file: $pi_state"
  pi_state_existed=1
  cp -p "$pi_state" "$pi_state_backup"
else
  mkdir -p "$(dirname "$pi_state")"
  printf '%s\n' 'lifecycle-preservation-pi' > "$pi_state"
fi
if [ -e "$omp_state" ] || [ -L "$omp_state" ]; then
  [ -f "$omp_state" ] || fail "OMP native state is not a regular file: $omp_state"
  omp_state_existed=1
  cp -p "$omp_state" "$omp_state_backup"
else
  mkdir -p "$(dirname "$omp_state")"
  printf '%s\n' 'lifecycle-preservation-omp' > "$omp_state"
fi
pi_before=$(sha256_file "$pi_state")
omp_before=$(sha256_file "$omp_state")
run_installer() {
  install_tag=$1
  install_prefix=$2
  shift 2
  install_version=${install_tag#fork-v}
  sh "$root/releases/$install_tag/install.sh" \
    --profile pi-omp \
    --release-base-url "https://github.com/$repository/releases/download/$install_tag" \
    --version "$install_version" \
    --prefix "$install_prefix" "$@"
}

assert_version() {
  check_prefix=$1
  expected_version=$2
  [ -x "$check_prefix/bin/t3-pi-omp" ] || fail "installed CLI is missing at $check_prefix"
  version_output=$("$check_prefix/bin/t3-pi-omp" --version 2>&1) || fail "--version failed for $expected_version"
  case "$version_output" in
    *"$expected_version"*) ;;
    *) fail "expected version $expected_version, got: $version_output" ;;
  esac
  help_output=$("$check_prefix/bin/t3-pi-omp" --help 2>&1) || fail "--help failed for $expected_version"
  case "$help_output" in
    *"Run the T3 Code server"*) ;;
    *) fail "help output did not describe the server command" ;;
  esac
}
assert_prefix_unchanged() {
  check_prefix=$1
  expected_active_target=$2
  expected_active_version=$3
  expected_previous_version=$4
  expected_owner_hash=$5
  [ -L "$check_prefix/active" ] || fail "failed install changed the active pointer type"
  [ "$(readlink "$check_prefix/active")" = "$expected_active_target" ] ||
    fail "failed install changed the active pointer"
  [ "$(cat "$check_prefix/.active-version")" = "$expected_active_version" ] ||
    fail "failed install changed the active version"
  [ "$(cat "$check_prefix/.previous-version" 2>/dev/null || true)" = "$expected_previous_version" ] ||
    fail "failed install changed the previous version"
  [ ! -e "$check_prefix/versions/$current_version" ] ||
    fail "failed install left a current version directory"
  [ "$(sha256_file "$check_prefix/.t3-install-owner")" = "$expected_owner_hash" ] ||
    fail "failed install changed the ownership marker"
}
make_mutating_curl() {
  mutation_bin="$root/mutation-bin"
  mkdir -p "$mutation_bin"
  real_curl=$(command -v curl)
  cat > "$mutation_bin/curl" <<'SH'
#!/bin/sh
set -eu
output=
url=
previous=
for arg in "$@"; do
  case "$previous" in
    --output|-o) output=$arg ;;
  esac
  case "$arg" in
    https://*|http://*) url=$arg ;;
  esac
  previous=$arg
done
[ -n "$output" ] || exec "$T3_LIFECYCLE_REAL_CURL" "$@"
asset=${url##*/}
if [ "${T3_LIFECYCLE_MUTATION_MODE:-}" = missing ] &&
  [ "$asset" = "${T3_LIFECYCLE_MUTATION_ASSET:-}" ]; then
  rm -f "$output"
  exit 22
fi
if [ "${T3_LIFECYCLE_MUTATION_MODE:-}" = partial ] &&
  [ "$asset" = "${T3_LIFECYCLE_MUTATION_ASSET:-}" ]; then
  "$T3_LIFECYCLE_REAL_CURL" "$@"
  node - "$output" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const size = fs.statSync(path).size;
fs.truncateSync(path, Math.max(1, Math.floor(size / 2)));
NODE
  exit 18
fi
"$T3_LIFECYCLE_REAL_CURL" "$@"
if [ "${T3_LIFECYCLE_MUTATION_MODE:-}" = checksum ] && [ "$asset" = SHA256SUMS ]; then
  awk '$2 == "RELEASE-MANIFEST.json" || $2 == "./RELEASE-MANIFEST.json" { $1 = "0000000000000000000000000000000000000000000000000000000000000000" } { print }' "$output" > "$output.mutated"
  mv "$output.mutated" "$output"
fi
SH
  chmod 755 "$mutation_bin/curl"
}

desktop_identity_smoke() {
  tag=$1
  desktop_prefix=$2
  manifest="$root/releases/$tag/RELEASE-MANIFEST.json"
  details=$(manifest_asset_details "$manifest" desktop)
  desktop_name=${details%%	*}
  desktop_hash=${details#*	}
  desktop_file="$desktop_prefix/active/desktop/${desktop_name##*/}"
  [ -f "$desktop_file" ] || fail "desktop artifact is missing at $desktop_file"
  case "$host_platform:$desktop_name" in
    darwin:*.dmg|linux:*.AppImage|linux:*.appimage) ;;
    *) fail "desktop artifact has unexpected name '$desktop_name'" ;;
  esac
  desktop_actual=$(verify_checksum_entry "$desktop_file" "$root/releases/$tag/SHA256SUMS" "${desktop_name##*/}")
  [ -z "$desktop_hash" ] || [ "$desktop_actual" = "$desktop_hash" ] ||
    fail "desktop manifest checksum mismatch for $desktop_name"
  printf '%s\t%s\t%s\n' "$tag" "${desktop_name##*/}" "$desktop_actual" >> "$root/desktop-hashes.tsv"
  case "$host_platform" in
    darwin)
      desktop_mount="$root/desktop-mount-$tag"
      mkdir -p "$desktop_mount"
      run_bounded 30 hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$desktop_mount" "$desktop_file" >/dev/null
      desktop_app=$(find "$desktop_mount" -type d -name '*.app' -print | awk 'NF { print; exit }')
      [ -n "$desktop_app" ] || { detach_desktop_mount; fail "DMG has no application bundle"; }
      plist="$desktop_app/Contents/Info.plist"
      [ -f "$plist" ] || { detach_desktop_mount; fail "DMG application has no Info.plist"; }
      bundle_version=$(plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null || true)
      [ -n "$bundle_version" ] || bundle_version=$(plutil -extract CFBundleVersion raw -o - "$plist" 2>/dev/null || true)
      case "$bundle_version" in
        *"${tag#fork-v}"*) ;;
        *) detach_desktop_mount; fail "DMG identity did not expose ${tag#fork-v}: $bundle_version" ;;
      esac
      ;;
    linux)
      extraction="$root/desktop-extract-$tag"
      mkdir -p "$extraction"
      staged="$extraction/${desktop_name##*/}"
      cp "$desktop_file" "$staged"
      chmod 755 "$staged"
      (cd "$extraction" && run_bounded 30 "$staged" --appimage-extract >/dev/null)
      squashfs_root="$extraction/squashfs-root"
      [ -x "$squashfs_root/AppRun" ] || fail "AppImage extraction has no executable AppRun"
      desktop_entry=$(find "$squashfs_root" -type f -name '*.desktop' -print | awk 'NF { print; exit }')
      [ -n "$desktop_entry" ] || fail "AppImage extraction has no desktop entry"
      awk '/^Name=.*T3 Code/ { found = 1 } END { exit found ? 0 : 1 }' "$desktop_entry" ||
        fail "AppImage desktop entry has no T3 Code identity"
      case "$desktop_name" in
        *"${tag#fork-v}"*) ;;
        *) fail "AppImage identity did not expose ${tag#fork-v}: $desktop_name" ;;
      esac
      ;;
  esac
  detach_desktop_mount
}

install_official_t3() {
  official_version=0.0.33
  official_base="https://github.com/pingdotgg/t3code/releases/download/v$official_version"
  mkdir -p "$official_prefix"
  case "$host_platform:$host_arch" in
    darwin:arm64)
      official_artifact="T3-Code-$official_version-arm64.dmg"
      official_expected_sha=d8c42f3d79047ce43c073922a8abf9546b43b78b7f84c5bc6f95815d873eddd0
      official_kind=installed-dmg
      ;;
    darwin:x64)
      official_artifact="T3-Code-$official_version-x64.dmg"
      official_expected_sha=2c394045f2ed76dead0d8859bcea34db4815bbcba9276cb18788bc2b7248bc30
      official_kind=installed-dmg
      ;;
    linux:x64)
      official_artifact="T3-Code-$official_version-x86_64.AppImage"
      official_expected_sha=415c8648f43c3d22d572f27f2c50fdc8c310ea7fcde9537b903e1e2f1c8775a1
      official_kind=extracted-appimage
      ;;
    linux:arm64)
      official_artifact=latest-linux.yml
      official_expected_sha=d68733625a7c4f35bd84a3ac9446fdd2fed2c8e593d1e32e6d444284c921a66f
      official_kind=release-metadata-no-linux-arm64-artifact
      ;;
    *) fail "no official T3 identity branch for $host_platform/$host_arch" ;;
  esac
  official_download="$official_prefix/$official_artifact"
  curl -fsSL "$official_base/$official_artifact" -o "$official_download"
  official_actual_sha=$(sha256_file "$official_download")
  [ "$official_actual_sha" = "$official_expected_sha" ] ||
    fail "official T3 artifact checksum mismatch for $official_artifact"
  case "$official_kind" in
    installed-dmg)
      desktop_mount="$root/official-t3-mount"
      mkdir -p "$desktop_mount"
      run_bounded 30 hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$desktop_mount" "$official_download" >/dev/null
      official_app=$(find "$desktop_mount" -type d -name '*.app' -print | awk 'NF { print; exit }')
      [ -n "$official_app" ] || { detach_desktop_mount; fail "official T3 DMG has no application bundle"; }
      official_executable_name=$(plutil -extract CFBundleExecutable raw -o - "$official_app/Contents/Info.plist")
      cp -R "$official_app" "$official_prefix/"
      official_evidence="$official_prefix/${official_app##*/}/Contents/MacOS/$official_executable_name"
      detach_desktop_mount
      ;;
    extracted-appimage)
      chmod 755 "$official_download"
      (cd "$official_prefix" && run_bounded 30 "./$official_artifact" --appimage-extract >/dev/null)
      official_evidence="$official_prefix/squashfs-root/AppRun"
      ;;
    release-metadata-no-linux-arm64-artifact)
      official_evidence="$official_download"
      node - "$official_download" <<'NODE'
const fs = require("node:fs");
const metadata = fs.readFileSync(process.argv[2], "utf8");
if (/arm64|aarch64/iu.test(metadata)) {
  throw new Error("Official T3 Linux metadata unexpectedly advertises an arm64 artifact");
}
NODE
      ;;
  esac
  [ -f "$official_evidence" ] || fail "official T3 evidence is missing"
}


official_prefix="$root/official-t3"
install_official_t3
official_evidence_before=$(sha256_file "$official_evidence")
preexisting_bin="$root/preexisting-command/bin"
mkdir -p "$preexisting_bin"
cat > "$preexisting_bin/t3" <<'SH'
#!/bin/sh
printf '%s\n' 'preexisting-t3-command'
SH
chmod 755 "$preexisting_bin/t3"
preexisting_t3_before=$(sha256_file "$preexisting_bin/t3")
PATH="$preexisting_bin:$PATH"
export PATH

prefix="$root/prefix"
run_installer "$previous_tag" "$prefix"
assert_version "$prefix" "$previous_version"
prefix_active_target=$(readlink "$prefix/active")
prefix_active_version=$(cat "$prefix/.active-version")
prefix_previous_version=$(cat "$prefix/.previous-version" 2>/dev/null || true)
prefix_owner_hash=$(sha256_file "$prefix/.t3-install-owner")
make_mutating_curl
if PATH="$root/mutation-bin:$PATH" T3_LIFECYCLE_REAL_CURL="$real_curl" \
  T3_LIFECYCLE_MUTATION_MODE=checksum \
  sh "$root/releases/$current_tag/install.sh" --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/$current_tag" \
  --version "$current_version" --prefix "$prefix" >/dev/null 2>&1
then
  fail "tampered SHA256SUMS unexpectedly succeeded"
fi
assert_prefix_unchanged \
  "$prefix" "$prefix_active_target" "$prefix_active_version" "$prefix_previous_version" "$prefix_owner_hash"
cli_details=$(manifest_asset_details "$root/releases/$current_tag/RELEASE-MANIFEST.json" cli)
cli_name=${cli_details%%	*}
if PATH="$root/mutation-bin:$PATH" T3_LIFECYCLE_REAL_CURL="$real_curl" \
  T3_LIFECYCLE_MUTATION_MODE=missing T3_LIFECYCLE_MUTATION_ASSET="${cli_name##*/}" \
  sh "$root/releases/$current_tag/install.sh" --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/$current_tag" \
  --version "$current_version" --prefix "$prefix" >/dev/null 2>&1
then
  fail "missing CLI asset unexpectedly succeeded"
fi
assert_prefix_unchanged \
  "$prefix" "$prefix_active_target" "$prefix_active_version" "$prefix_previous_version" "$prefix_owner_hash"
if PATH="$root/mutation-bin:$PATH" T3_LIFECYCLE_REAL_CURL="$real_curl" \
  T3_LIFECYCLE_MUTATION_MODE=partial T3_LIFECYCLE_MUTATION_ASSET="${cli_name##*/}" \
  sh "$root/releases/$current_tag/install.sh" --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/$current_tag" \
  --version "$current_version" --prefix "$prefix" >/dev/null 2>&1
then
  fail "partial CLI download unexpectedly succeeded"
fi
assert_prefix_unchanged \
  "$prefix" "$prefix_active_target" "$prefix_active_version" "$prefix_previous_version" "$prefix_owner_hash"
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

desktop_prefix="$root/desktop-prefix"
run_installer "$previous_tag" "$desktop_prefix" --desktop
assert_version "$desktop_prefix" "$previous_version"
desktop_identity_smoke "$previous_tag" "$desktop_prefix"
run_installer "$current_tag" "$desktop_prefix" --desktop
assert_version "$desktop_prefix" "$current_version"
desktop_identity_smoke "$current_tag" "$desktop_prefix"
sh "$root/releases/$current_tag/install.sh" --profile pi-omp --prefix "$desktop_prefix" --rollback
assert_version "$desktop_prefix" "$previous_version"
desktop_identity_smoke "$previous_tag" "$desktop_prefix"
sh "$root/releases/$current_tag/install.sh" --profile pi-omp --prefix "$desktop_prefix" --uninstall
[ ! -e "$desktop_prefix" ] || fail "desktop uninstall left the owned prefix"

bad_prefix="$root/bad-prefix"
if sh "$root/releases/$current_tag/install.sh" \
  --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/fork-v99.99.99" \
  --version 99.99.99 \
  --prefix "$bad_prefix" >/dev/null 2>&1
then
  fail "missing release unexpectedly succeeded"
fi
[ ! -e "$bad_prefix" ] || fail "missing release mutated its prefix"
unsupported_bin="$root/unsupported-platform-bin"
unsupported_prefix="$root/unsupported-platform-prefix"
mkdir -p "$unsupported_bin"
cat > "$unsupported_bin/uname" <<'SH'
#!/bin/sh
printf '%s\n' 'Plan9'
SH
chmod 755 "$unsupported_bin/uname"
if PATH="$unsupported_bin:$PATH" sh "$root/releases/$current_tag/install.sh" \
  --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/$current_tag" \
  --version "$current_version" \
  --prefix "$unsupported_prefix" >/dev/null 2>&1
then
  fail "unsupported platform unexpectedly succeeded"
fi
[ ! -e "$unsupported_prefix" ] || fail "unsupported platform mutated its prefix"

missing_node_bin="$root/missing-node-bin"
missing_node_prefix="$root/missing-node-prefix"
mkdir -p "$missing_node_bin"
cat > "$missing_node_bin/node" <<'SH'
#!/bin/sh
printf '%s\n' 'node unavailable' >&2
exit 127
SH
chmod 755 "$missing_node_bin/node"
if PATH="$missing_node_bin:$PATH" sh "$root/releases/$current_tag/install.sh" \
  --profile pi-omp \
  --release-base-url "https://github.com/$repository/releases/download/$current_tag" \
  --version "$current_version" \
  --prefix "$missing_node_prefix" >/dev/null 2>&1
then
  fail "missing Node runtime unexpectedly succeeded"
fi
[ ! -e "$missing_node_prefix" ] || fail "missing Node runtime mutated its prefix"


sh "$root/releases/$current_tag/install.sh" --profile pi-omp --prefix "$prefix" --uninstall
[ ! -e "$prefix" ] || fail "uninstall left the owned prefix"

[ "$(sha256_file "$pi_state")" = "$pi_before" ] || fail "Pi native state changed"
[ "$(sha256_file "$omp_state")" = "$omp_before" ] || fail "OMP native state changed"
[ "$(sha256_file "$official_evidence")" = "$official_evidence_before" ] ||
  fail "side-by-side official T3 artifact changed"
[ "$(sha256_file "$preexisting_bin/t3")" = "$preexisting_t3_before" ] ||
  fail "pre-existing t3 command changed"

node - "$report_path" "$root/release-hashes.tsv" "$root/desktop-hashes.tsv" "$root/releases" \
  "$current_tag" "$previous_tag" "$official_version" "$official_kind" "$official_artifact" \
  "$official_actual_sha" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [report, hashes, desktopHashes, releaseRoot, currentTag, previousTag, officialVersion, officialKind, officialArtifact, officialSha256] = process.argv.slice(2);
const releaseHashes = fs.readFileSync(hashes, "utf8").trim().split("\n").map((line) => {
  const [tag, installerSha256, manifestSha256] = line.split("\t");
  return { tag, installerSha256, manifestSha256 };
});
const desktopArtifacts = fs.readFileSync(desktopHashes, "utf8").trim().split("\n").map((line) => {
  const [tag, name, sha256] = line.split("\t");
  return { tag, name, sha256 };
});
const cliArtifacts = [previousTag, currentTag].map((tag) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(releaseRoot, tag, "RELEASE-MANIFEST.json"), "utf8"));
  const cli = manifest.artifacts.find((artifact) => artifact.kind === "cli");
  if (!cli || typeof cli.path !== "string" || !/^[0-9a-f]{64}$/u.test(cli.sha256)) {
    throw new Error(`Release ${tag} has no hashed CLI artifact`);
  }
  return { tag, name: path.basename(cli.path), sha256: cli.sha256 };
});
fs.writeFileSync(report, JSON.stringify({
  schemaVersion: 1,
  profile: "pi-omp",
  platform: process.platform,
  architecture: process.arch,
  currentTag,
  previousTag,
  checks: [
    "fresh-install", "upgrade", "version-help", "server-health", "rollback",
    "tampered-checksum-no-mutation", "missing-asset-no-mutation",
    "partial-download-no-mutation", "missing-release-no-mutation",
    "unsupported-platform-no-mutation", "missing-node-no-mutation",
    "side-by-side-official-t3-artifact", "preexisting-t3-command-preservation",
    "desktop-install", "desktop-upgrade",
    "desktop-identity", "desktop-rollback", "desktop-uninstall", "uninstall",
    "native-config-preservation",
  ],
  releaseHashes,
  desktopArtifacts,
  cliArtifacts,
  officialT3: {
    version: officialVersion,
    kind: officialKind,
    artifact: officialArtifact,
    sha256: officialSha256,
  },
}, null, 2) + "\n");
NODE
printf '%s\n' "POSIX release lifecycle passed for $current_tag on $(uname -s)/$(uname -m)"
