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
- **Test** runs on Ubuntu 24.04. `vp run test` runs the workspace test scripts, followed by the
  resource-monitor Rust tests. The job also runs the focused Pi/OMP protocol fixture tests
  (`ProtocolContract`, `NativeAdapter`, `OmpChunkAssembler`, and `StrictJsonlDecoder`). These
  fixtures spawn the current Node process; they do not download or invoke stock Pi or OMP binaries.
- **Pi OMP Focused Gate** runs on Ubuntu 24.04 within twelve minutes. It replays the scrubbed Pi
  and OMP corpora, runs the deterministic native replay through the T3 authenticated HTTP and
  WebSocket surfaces, runs credential-free spawned-process smoke for both dialects, exercises the
  transfer-budget and authenticated reconnect-convergence tests, and records a deterministic
  performance baseline. Its artifact contains aggregate transfer/performance data only.
- **Mobile Native Static Analysis** runs on macOS 26 because the mobile native
  toolchain and `apps/mobile/Brewfile` are macOS-only. It installs those tools
  and runs `vp run lint:mobile`. This is not a mobile simulator/device test and
  does not add a Windows or Linux native lane.
- **Release Smoke** runs on Ubuntu 24.04 with `vp run release:smoke`. The
  existing `scripts/release-smoke.ts` uses a temporary manifest fixture,
  exercises release-version/tag and updater-manifest logic, and checks
  release-workflow, publish, and installer invariants. It does not publish,
  sign, notarize, build an Electron artifact, or use release credentials.

The Check job runs `vp run check:ts-relative-imports` against the provider/decoder/projector scope
(`apps/server/src/provider/piFamily`) and `vp run check:workflow-action-pins`. The former requires
explicit relative source extensions under the provider scope; the latter requires immutable action
SHAs with revision comments and verifies the workflow-run publisher checks out only the trusted
default branch.

These jobs use GitHub-hosted runner labels so they execute in the owner-controlled fork without
requiring the upstream Blacksmith runner integration. The production relay workflow skips fork
pushes unless `T3_ENABLE_RELAY_DEPLOY=true`; fork releases consume their separately configured relay
metadata instead of deploying upstream infrastructure.

## Private state canary

[`private-state-canary.yml`](../../.github/workflows/private-state-canary.yml) is a scheduled,
owner-controlled lane, not a pull-request gate. It requires a Linux self-hosted runner labeled
`private-state` and the repository variable `T3_PRIVATE_STATE_DB`, whose value is an absolute path
to a stopped local `state.sqlite`. The lane fails closed when either is absent.

The job snapshots the source with SQLite `VACUUM INTO`, migrates and reprojects disposable copies,
compares aggregate state, and deletes every copied database in a shell `trap`. It publishes no
artifact and logs no private rows, prompts, paths, or native output. The `migration` injection
must fail while preserving the source digest and leaving only a mode-0600 aggregate report in the
mode-0700 temporary directory.

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

### Native runtime lanes

The supported native-runtime claim is intentionally narrow. The lane is selected by the
configured binary path and is never inferred from a provider label:

| Runtime lane           | Version/revision                                                                                                                                                                                     | Protocol proof                                                                               | Support status                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pi audited binary      | `0.84.2` / `binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521`                                                                                                          | Pi RPC v1; strict LF JSONL; model/state/capability discovery                                 | Supported                                            |
| OMP integration binary | `17.3.7` / `binary-sha256:6a912163e0e2f63ae89ca14dd382b683f15126e783202c68aa783c5fb970f9e1` (clean revalidated; archived fixture `c1434d85392024aab964220b3c3fd27afe1241d13d5488dac84b489d1f052b0d`) | ready v1, v1/v2 advertisement, v2 negotiation, bounded chunk transport, capability discovery | Supported on the clean revalidated integration build |
| OMP default binary     | `18.0.0` / `binary-sha256:78870640abcb930e1abbe128baf1b636ecd1fe8326af42ac3652e4a4654112f7`                                                                                                          | emits ready v1 but does not implement the T3 `get_capabilities` RPC contract                 | Unsupported; select the audited integration binary   |

The Pi and OMP rows were probed through their native RPC entrypoints on the current
arm64 workstation. The probe verified version, framing, capability/discovery responses,
and clean stdin-close teardown. It is not a substitute for the authenticated T3
root-turn gate; that remains an external compatibility check.

### Node and package manager

The repository root declares Node.js `^24.13.1` and `pnpm@11.10.0`.
Pull-request CI uses `setup-vp` with that root declaration and Vite Plus for
installation and tasks.

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

### Native trace replay layers and fixture governance

Native trace evidence has one owner and one oracle at each boundary. A test must enter at the
lowest layer named by its claim; parsed-object fixtures cannot prove byte framing or assembly.

| Layer                                          | Owner                                             | Oracle                                                                                        |
| ---------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Raw stdin/stdout/stderr bytes and process exit | `NativeAdapter` plus `BoundedNativeTraceRecorder` | Ordered chunk hashes, byte lengths, stream names, and one terminal exit record                |
| Decoded JSONL envelopes                        | `StrictJsonlDecoder`                              | Explicit frame types, request IDs, malformed/truncated outcome, and decoder completion        |
| Reassembled OMP messages                       | `OmpChunkAssembler`                               | Message identity, chunk order/count, complete payload hash, and zero pending messages         |
| Normalized adapter events                      | `PiFamilyEventProjector`                          | Manifest-owned `adapterEventTypes` and terminal adapter status                                |
| Canonical provider events                      | `NativeAdapter.eventForProjection`                | Manifest-owned canonical event sequence, lifecycle, output marker, and terminal status        |
| Persisted canonical state                      | Provider runtime ingestion and projectors         | Independently declared state/task/checkpoint invariants and state hashes in their owner tests |
| HTTP bootstrap snapshot                        | Server read-model/bootstrap services              | Existing bootstrap contract and transfer-budget fixtures                                      |
| WebSocket update stream                        | Server update transport and client runtime        | Existing ordered update, resume, deduplication, and convergence fixtures                      |

Raw captures are private temporary artifacts with mode-0700 directories and mode-0600 files. They
must never enter git. A committed fixture is a scrubbed structural replay subject, not evidence of
the model's real output. It must declare runtime/version/binary provenance, normalization and
redaction schema versions, reviewed redaction status, capture mode (`native-recorder` for a
non-synthetic capture or `synthetic-replay` for a generated fixture), expected outcome hash, and
whether it is generated or synthetic. `validateNativeTraceCorpus` rejects duplicate IDs, missing or
inconsistent provenance, bad chunk/hash/length/sequence data, unsupported schemas, truncation,
unreviewed redaction, leak findings, and expected outcomes bound to another fixture.

The committed corpus is intentionally minimal: handshake fixtures are **minimal** and root-turn
fixtures are **typical**. Stress and error behavior stays generated in focused tests until a
privacy-safe exact capture is needed; generated cases must never be relabeled as native captures.
Every committed fixture is capped at 1 MiB by `NativeTraceCorpus.test.ts`. Replace a fixture only
when its pinned binary/protocol changes or the old case no longer covers its declared behavior.
Replacement requires fresh provenance, deterministic scrub/review, hashes, focused replay, and
independent review. A source protocol, projector contract, normalization schema, or redaction
schema change invalidates the affected fixture review even when its JSON still parses.

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

The published `fork-v0.0.47` release contains every target in the matrix above plus the
profile-specific CLI/web tarball. Release workflow run
[`32718276003`](https://github.com/kmccleary3301/t3code/actions/runs/32718276003) built Linux
arm64/x64, macOS arm64/x64, and Windows x64 on matching GitHub-hosted runners. GitHub provenance
attestations cover the release assets. Platform-signing credentials were not configured, so the
desktop artifacts are unsigned and the macOS artifacts are unnotarized.

The current `fork-v0.0.47` lifecycle run
[`32721583970`](https://github.com/kmccleary3301/t3code/actions/runs/32721583970) passed all five
target-host jobs. POSIX jobs exercised CLI install/upgrade/rollback/uninstall and native-config
preservation on macOS arm64/x64 and Linux arm64/x64, plus desktop artifact install/upgrade/identity/
rollback/uninstall and tampered-checksum, partial-download, missing-asset, and missing-release
no-mutation checks. The Windows job exercised CLI and NSIS desktop install/upgrade/rollback/uninstall
with disposable Pi/OMP state roots. The prior `fork-v0.0.46` lifecycle run remains separately
recorded as historical release evidence.

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
npm or Node archives; installer behavior on musl; execution of desktop artifacts from
arbitrary releases outside the exercised `fork-v0.0.47` lifecycle matrix (with `fork-v0.0.46`
retained as historical evidence); notarization, signing, and update delivery beyond the exercised lifecycle; and
cross-platform desktop integration outside that matrix. A green pull request therefore must not be
described as proof of any of those properties.

See [Release Checklist](../operations/release.md) for the release/signing
setup checklist.
