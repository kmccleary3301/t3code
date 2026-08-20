// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dirname, "install.sh");

const sha256 = (path: string) => {
  const digest = createHash("sha256");
  digest.update(readFileSync(path));
  return digest.digest("hex");
};

const writeExecutable = (path: string, source: string) => {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
};

const makeFixture = (
  profile: "upstream" | "pi-omp",
  version: string,
  options?: { runtimes?: boolean; desktop?: boolean },
  fixtureRoot?: string,
) => {
  const root = fixtureRoot ?? mkdtempSync(join(tmpdir(), "t3-installer-release-"));
  const release = join(root, "releases", version);
  mkdirSync(release, { recursive: true });
  const packageName = profile === "upstream" ? "t3" : "t3-pi-omp";
  const binaryName = packageName;
  const cliName = `${packageName}-${version}`;
  writeExecutable(
    join(release, cliName),
    `#!/bin/sh
set -eu
case "${"$"}{1:-}" in
  --version) printf '%s\\n' '${binaryName} ${version}' ;;
  *) exit 0 ;;
esac
`,
  );

  const artifacts: Array<Record<string, string>> = [{ kind: "cli", path: cliName, sha256: "" }];
  const checksums: string[] = [];
  const addAsset = (name: string, kind: string, extra?: Record<string, string>) => {
    const asset = join(release, name);
    artifacts.push({ kind, path: name, sha256: sha256(asset), ...(extra ?? {}) });
    checksums.push(`${sha256(asset)}  ${name}`);
  };
  addAsset(cliName, "cli");

  if (options?.desktop) {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const extension = platform === "darwin" ? "dmg" : "AppImage";
    const desktopName = `T3-Code-${version}-${platform}-${arch}.${extension}`;
    writeFileSync(join(release, desktopName), "desktop fixture\n");
    addAsset(desktopName, "desktop", { platform, arch });
  }

  if (options?.runtimes) {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const runtimeRoot = join(root, "runtime-source");
    for (const runtime of ["pi", "omp"] as const) {
      mkdirSync(join(runtimeRoot, runtime, "bin"), { recursive: true });
      writeExecutable(
        join(runtimeRoot, runtime, "bin", runtime),
        `#!/bin/sh\nprintf '%s\\n' '${runtime} ${version}'\n`,
      );
      const runtimeName = `${runtime}-${version}-${platform}-${arch}.tar.gz`;
      execFileSync("tar", [
        "-czf",
        join(release, runtimeName),
        "-C",
        join(runtimeRoot, runtime),
        ".",
      ]);
      addAsset(runtimeName, "runtime", { runtime, platform, arch });
    }
    rmSync(runtimeRoot, { recursive: true, force: true });
  }

  const manifestPath = join(release, "RELEASE-MANIFEST.json");
  const manifest = {
    schemaVersion: 1,
    profile,
    package: { name: packageName, bin: binaryName, version },
    bin: binaryName,
    clientVersion: version,
    channel: "latest",
    artifacts,
  };
  // The first CLI artifact's digest is filled after the file exists.
  manifest.artifacts[0]!.sha256 = sha256(join(release, cliName));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  checksums.unshift(`${sha256(manifestPath)}  RELEASE-MANIFEST.json`);
  writeFileSync(join(release, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return { root, release, manifestPath, cliName };
};

const makeCurl = (root: string) => {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, "curl");
  writeExecutable(
    curl,
    `#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_CURL_LOG"
relative=${"${url#https://fixtures.test/}"}
case "$url" in
  *api.github.com/repos/*) cp "$NIGHTLY_API_FIXTURE" "$output" ;;
  https://github.com/*/releases/download/*)
    release_path=${"${url#*/releases/download/}"}
    release_tag=${"${release_path%%/*}"}
    asset_name=${"${release_path#*/}"}
    cp "$FIXTURE_ROOT/releases/$release_tag/$asset_name" "$output"
    ;;
  *) cp "$FIXTURE_ROOT/$relative" "$output" ;;
esac
`,
  );
  return bin;
};

const runInstaller = (args: string[], env: Record<string, string | undefined>, cwdRoot: string) =>
  spawnSync("sh", [installer, ...args], {
    cwd: cwdRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

it("rejects missing manifests and bad checksums before mutating a prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-installer-negative-"));
  const fakeBin = makeCurl(root);
  const prefix = join(root, "prefix");
  try {
    const missing = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/missing",
        "--prefix",
        prefix,
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
      },
      root,
    );
    assert.notEqual(missing.status, 0);
    assert.isFalse(existsSync(prefix));

    const fixture = makeFixture("pi-omp", "1.0.0", undefined, root);
    writeFileSync(join(fixture.release, fixture.cliName), "tampered\n");
    const bad = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/1.0.0",
        "--prefix",
        prefix,
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
      },
      root,
    );
    assert.notEqual(bad.status, 0);
    assert.include(`${bad.stdout}${bad.stderr}`, "checksum");
    assert.isFalse(existsSync(prefix));
    makeFixture("pi-omp", "2.0.0", undefined, root);
    const missingRuntime = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/2.0.0",
        "--prefix",
        prefix,
        "--install-runtimes",
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
      },
      root,
    );
    assert.notEqual(missingRuntime.status, 0);
    assert.include(`${missingRuntime.stdout}${missingRuntime.stderr}`, "runtime");
    assert.isFalse(existsSync(prefix));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("installs, upgrades atomically, rolls back, and uninstalls only its owned prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-installer-atomic-"));
  const fakeBin = makeCurl(root);
  const prefix = join(root, "prefix");
  const env = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    FIXTURE_ROOT: root,
    FAKE_CURL_LOG: join(root, "curl.log"),
  };
  try {
    const first = makeFixture("pi-omp", "1.0.0", undefined, root);
    const installed = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/1.0.0",
        "--prefix",
        prefix,
      ],
      env,
      root,
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(readFileSync(join(prefix, ".active-version"), "utf8").trim(), "1.0.0");
    assert.equal(
      execFileSync(join(prefix, "bin", "t3-pi-omp"), ["--version"], { encoding: "utf8" }).trim(),
      "t3-pi-omp 1.0.0",
    );
    assert.include(installed.stdout, "Existing pi:");
    assert.include(installed.stdout, "Existing omp:");

    makeFixture("pi-omp", "2.0.0", undefined, root);
    const upgraded = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/2.0.0",
        "--prefix",
        prefix,
      ],
      env,
      root,
    );
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(readFileSync(join(prefix, ".active-version"), "utf8").trim(), "2.0.0");
    assert.equal(
      execFileSync(join(prefix, "bin", "t3-pi-omp"), ["--version"], { encoding: "utf8" }).trim(),
      "t3-pi-omp 2.0.0",
    );
    assert.isTrue(existsSync(join(prefix, "versions", "1.0.0")));
    assert.equal(readFileSync(join(prefix, ".previous-version"), "utf8").trim(), "1.0.0");

    const rolledBack = runInstaller(
      ["--profile", "pi-omp", "--prefix", prefix, "--rollback"],
      env,
      root,
    );
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(readFileSync(join(prefix, ".active-version"), "utf8").trim(), "1.0.0");
    assert.equal(
      execFileSync(join(prefix, "bin", "t3-pi-omp"), ["--version"], { encoding: "utf8" }).trim(),
      "t3-pi-omp 1.0.0",
    );
    const uninstalled = runInstaller(
      ["--profile", "pi-omp", "--prefix", prefix, "--uninstall"],
      env,
      root,
    );
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.isFalse(existsSync(prefix));
    void first;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps default upstream and pi-omp prefixes side by side and keeps dry-run side-effect free", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-installer-side-by-side-"));
  const fakeBin = makeCurl(root);
  const dataHome = join(root, "data");
  const env = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    FIXTURE_ROOT: root,
    FAKE_CURL_LOG: join(root, "curl.log"),
    XDG_DATA_HOME: dataHome,
  };
  try {
    makeFixture("upstream", "1.0.0", undefined, root);
    const dry = runInstaller(
      [
        "--profile",
        "upstream",
        "--release-base-url",
        "https://fixtures.test/releases/1.0.0",
        "--dry-run",
      ],
      env,
      root,
    );
    assert.equal(dry.status, 0, dry.stderr);
    assert.isFalse(existsSync(dataHome));
    assert.isFalse(existsSync(join(root, "curl.log")));

    const upstream = runInstaller(
      ["--profile", "upstream", "--release-base-url", "https://fixtures.test/releases/1.0.0"],
      env,
      root,
    );
    assert.equal(upstream.status, 0, upstream.stderr);
    makeFixture("pi-omp", "1.0.0", undefined, root);
    const piOmp = runInstaller(
      ["--profile", "pi-omp", "--release-base-url", "https://fixtures.test/releases/1.0.0"],
      env,
      root,
    );
    assert.equal(piOmp.status, 0, piOmp.stderr);

    assert.isTrue(existsSync(join(dataHome, "t3code", "upstream", "bin", "t3")));
    assert.isTrue(existsSync(join(dataHome, "t3code", "pi-omp", "bin", "t3-pi-omp")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("resolves the newest profile-matching nightly through the GitHub releases API", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-installer-nightly-"));
  const fakeBin = makeCurl(root);
  const prefix = join(root, "prefix");
  const fixture = makeFixture("pi-omp", "1.0.0", undefined, root);
  const nightlyTag = "fork-v1.0.0-nightly.1";
  renameSync(fixture.release, join(root, "releases", nightlyTag));
  const apiFixture = join(root, "nightly-releases.json");
  writeFileSync(
    apiFixture,
    JSON.stringify([
      { tag_name: "fork-v1.0.0-nightly.1", prerelease: true, draft: false },
      { tag_name: "v1.0.0-nightly.2", prerelease: true, draft: false },
    ]),
  );
  try {
    const result = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--repository",
        "owner/t3-private",
        "--channel",
        "nightly",
        "--prefix",
        prefix,
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
        NIGHTLY_API_FIXTURE: apiFixture,
      },
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(prefix, ".active-version"), "utf8").trim(), "1.0.0");
    assert.include(
      readFileSync(join(root, "curl.log"), "utf8"),
      "https://api.github.com/repos/owner/t3-private/releases?per_page=30",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("selects and verifies desktop and pinned Pi/OMP runtime assets", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-installer-assets-"));
  const fakeBin = makeCurl(root);
  const prefix = join(root, "prefix");
  try {
    makeFixture("pi-omp", "1.0.0", { desktop: true, runtimes: true }, root);
    const result = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/1.0.0",
        "--prefix",
        prefix,
        "--desktop",
        "--install-runtimes",
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
      },
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Desktop artifact:");
    const expectedDesktopName = `T3-Code-1.0.0-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}.${process.platform === "darwin" ? "dmg" : "AppImage"}`;
    assert.isTrue(existsSync(join(prefix, "active", "desktop", expectedDesktopName)));
    assert.include(result.stdout, `PI_BINARY_PATH=${prefix}/active/runtimes/pi/bin/pi`);
    assert.include(result.stdout, `OMP_BINARY_PATH=${prefix}/active/runtimes/omp/bin/omp`);
    assert.isTrue(existsSync(join(prefix, "active", "runtimes", "pi", "bin", "pi")));
    assert.isTrue(existsSync(join(prefix, "active", "runtimes", "omp", "bin", "omp")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("uses a fake HTTPS npm package fallback and preserves the registry boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-installer-npm-"));
  const fakeBin = makeCurl(root);
  const prefix = join(root, "prefix");
  const fixture = makeFixture("pi-omp", "1.0.0", undefined, root);
  const archive = join(root, "t3-pi-omp-1.0.0.tgz");
  const packageRoot = join(root, "package", "bin");
  mkdirSync(packageRoot, { recursive: true });
  writeExecutable(
    join(packageRoot, "t3-pi-omp"),
    "#!/bin/sh\n[ \"${1:-}\" = --version ] && printf 'npm 1.0.0\\n'\n",
  );
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
    artifacts: Array<Record<string, string>>;
  };
  manifest.artifacts = manifest.artifacts.filter((asset) => asset.kind !== "cli");
  writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(fixture.release, "SHA256SUMS"),
    `${sha256(fixture.manifestPath)}  RELEASE-MANIFEST.json\n${sha256(archive)}  t3-pi-omp-1.0.0.tgz\n`,
  );
  const npm = join(fakeBin, "npm");
  writeExecutable(
    npm,
    `#!/bin/sh
set -eu
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in --pack-destination) destination=$2; shift 2 ;; *) shift ;; esac
done
mkdir -p "$destination"
cp "$NPM_TARBALL" "$destination/t3-pi-omp-1.0.0.tgz"
printf '%s\\n' 't3-pi-omp-1.0.0.tgz'
`,
  );
  try {
    const result = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/1.0.0",
        "--prefix",
        prefix,
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
        NPM_TARBALL: archive,
      },
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    const insecure = runInstaller(
      [
        "--profile",
        "pi-omp",
        "--release-base-url",
        "https://fixtures.test/releases/1.0.0",
        "--prefix",
        join(root, "other"),
        "--registry",
        "http://registry.invalid",
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FIXTURE_ROOT: root,
        FAKE_CURL_LOG: join(root, "curl.log"),
        NPM_TARBALL: archive,
      },
      root,
    );
    assert.notEqual(insecure.status, 0);
    assert.include(insecure.stderr, "https://");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
