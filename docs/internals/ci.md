# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

[`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pull
requests and on pushes to `main`. It is repository evidence, not a claim that
every release environment or native provider has been exercised.

## What pull-request CI executes

The four jobs are deliberately split by the tools and operating systems they
need:

- **Check** runs on Ubuntu 24.04. `setup-vp` reads the root `package.json`,
  installs with Vite Plus, and the job runs:
  - `vp test run scripts/install.test.ts` — installer argument, isolated-prefix,
    injection, and optional runtime-launcher tests using local fakes;
  - `vp test run packages/contracts/src/productIdentity.test.ts` — upstream and
    `pi-omp` identity separation and fail-closed profile parsing;
  - `vp check`, `vpr typecheck`, and Rust formatting;
  - `vp run build:desktop`, followed by assertions that the preload bundle
    exists and exports the expected bridge, passkey, protocol, and WebSocket
    symbols.
- **Test** runs on Ubuntu 24.04. `vp run test` runs the workspace test scripts,
  followed by the resource-monitor Rust tests. The job also runs the focused
  Pi/OMP protocol fixture tests (`ProtocolContract`, `NativeAdapter`,
  `OmpChunkAssembler`, and `StrictJsonlDecoder`). These fixtures spawn the
  current Node process; they do not download or invoke stock Pi or OMP
  binaries.
- **Mobile Native Static Analysis** runs on macOS 26 because the mobile native
  toolchain and `apps/mobile/Brewfile` are macOS-only. It installs those tools
  and runs `vp run lint:mobile`. This is not a mobile simulator/device test and
  does not add a Windows or Linux native lane.
- **Release Smoke** runs on Ubuntu 24.04 with `vp run release:smoke`. The
  existing `scripts/release-smoke.ts` uses a temporary manifest fixture,
  exercises release-version/tag and updater-manifest logic, and checks
  release-workflow, publish, and installer invariants. It does not publish,
  sign, notarize, build an Electron artifact, or use release credentials.

CI has no repository relative-import checker. No such command is present in
the package scripts, so CI does not invent one or silently skip one. The
`icons:check` script requires the macOS Icon Composer GUI and is likewise not
run on the headless runners; generated/product identity coverage in CI is the
contract test above plus the desktop build/preload assertions.

These jobs use GitHub-hosted runner labels so they execute in the owner-controlled fork without
requiring the upstream Blacksmith runner integration. The production relay workflow skips fork
pushes unless `T3_ENABLE_RELAY_DEPLOY=true`; fork releases consume their separately configured relay
metadata instead of deploying upstream infrastructure.

## Compatibility matrix

The release workflow selects a profile explicitly from its tag, input, or repository configuration.
An installed CLI can additionally recover the `pi-omp` profile from its dedicated package or binary
name when `T3_PRODUCT_PROFILE` is absent. Neither path infers behavior from a provider version.

| Concern           | T3 (`upstream`)           | Pi + OMP (`pi-omp`)            |
| ----------------- | ------------------------- | ------------------------------ |
| Stable tag        | `vX.Y.Z`                  | `fork-vX.Y.Z`                  |
| Nightly tag       | `vX.Y.Z-nightly.DATE.RUN` | `fork-vX.Y.Z-nightly.DATE.RUN` |
| npm package / CLI | `t3` / `t3`               | `t3-pi-omp` / `t3-pi-omp`      |
| Desktop bundle ID | `com.t3tools.t3code`      | `com.t3tools.t3code.piomp`     |
| Production scheme | `t3code`                  | `t3code-pi-omp`                |
| State directory   | `t3code`                  | `t3code-pi-omp`                |

### Node and package manager

- The repository root declares Node.js `^24.13.1` and `pnpm@11.10.0`.
  Pull-request CI uses `setup-vp` with that root declaration and Vite Plus for
  installation and tasks.
- The server package additionally declares
  `^22.16 || ^23.11 || >=24.10`; that wider runtime range does not change the
  Node declaration used by root CI.
- The POSIX installer does not install Node.js. It requires Node.js and npm for the
  profile-specific CLI package path. Routine CI uses a fake release server/package; the published
  `fork-v0.0.35` path was separately exercised through GitHub on an isolated prefix, including
  manifest/checksum verification, binary execution, uninstall, and confirmation that the discovered OMP
  installation remained unchanged.

### Pi and OMP runtime protocol baseline

The adapter accepts a runtime only through its wire contract and advertised
capabilities. It does not use a hidden version heuristic.

- **Both runtimes:** RPC is strict LF-delimited JSON. Responses correlate by
  request ID; malformed lines become runtime errors and later valid lines are
  still processed; process exit fails pending work. Unknown event types are
  retained as diagnostic raw envelopes rather than guessed into a newer
  schema. Optional capabilities default to absent until discovery says
  otherwise.
- **Pi:** protocol v1 only, with no `ready` frame, protocol negotiation, or
  chunked transport. The adapter starts RPC mode and best-effort queries
  `get_capabilities`; a missing response does not grant optional features.
- **OMP:** must emit a valid `ready` frame (initial protocol v1, support for
  v1/v2, 1 MiB frame and 64 MiB reassembled-message limits), then successfully
  negotiate protocol v2. OMP chunking is bounded by those limits. Capability
  discovery follows negotiation.
- **Feature gating:** model/thinking switching, commands, checkpoints,
  session resume/tree/fork/compact, UI requests, and task lifecycle are
  enabled only when the runtime advertises each capability. The baseline does
  not advertise arbitrary terminal components. In particular, nested tasks,
  workflows, background tasks, and child-task presentation are degraded or
  unavailable for Pi unless its capability response explicitly provides them;
  OMP may provide them, but CI only proves the adapter fixture behavior.

### Release artifact targets

The tag/scheduled release workflow currently builds these targets:

| Platform | Artifact target                   | Architecture and native limit                                                                    |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| macOS    | DMG and updater ZIP               | arm64 and x64                                                                                    |
| Linux    | AppImage                          | x64 and arm64, glibc (`x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`); no musl release |
| Windows  | NSIS installer and updater assets | x64 only, MSVC (`x86_64-pc-windows-msvc`); the Windows arm64 matrix entry is disabled            |

The artifact builder has code paths for additional architectures, but those paths are not release
evidence until a release matrix enables them. macOS signing/passkey and Windows Trusted Signing
depend on release-only credentials. Missing credentials produce unsigned artifacts where the release
workflow allows that; pull-request CI does not test signing.

The published `fork-v0.0.35` release contains every target in the matrix above plus the
profile-specific CLI/web tarball. Release workflow run `32340861002` built Linux arm64 on the
native `ubuntu-24.04-arm` runner and built the other four targets on their matching GitHub-hosted
runners. GitHub provenance attestations cover the release assets. Platform-signing credentials
were not configured, so the desktop artifacts are unsigned and the macOS artifacts are
unnotarized.

Optional Pi/OMP runtime bundles are supplied through the owner-controlled
`T3_PI_OMP_RUNTIME_BUNDLES_JSON` repository variable. The value is a JSON object with a `bundles`
array containing one HTTPS URL and SHA-256 digest per provider/platform/architecture. The release job
downloads and verifies those archives before publishing them. No runtime bundle is published when
the variable is unset; `--install-runtimes` then fails closed rather than downloading an unpinned
runtime. Bundles are supported only for macOS/Linux arm64/x64 and are never installed by default.

## Evidence boundaries

**Proven by repository CI:** the declared Vite Plus install/task graph;
format/lint/type checks; the desktop build and preload assertions; isolated
installer tests; product identity contract tests; Node-based Pi/OMP protocol,
malformed-frame, chunk, and process-lifecycle fixtures; mobile native static
analysis on macOS; and release-script/manifest/workflow smoke checks.

**Still release- or environment-gated:** launching stock Pi or OMP binaries;
compatibility with a particular native runtime version or capability payload;
real provider credentials and model/UI behavior; clean-machine installs from
npm or Node archives; installer behavior on Windows or musl; execution of
macOS/Linux/Windows artifacts on their target hosts; notarization, signing,
and update delivery; and cross-platform desktop integration. A green pull
request therefore must not be described as proof of any of those properties.

See [Release Checklist](../operations/release.md) for the release/signing
setup checklist.
