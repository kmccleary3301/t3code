# Release Checklist

> For maintainers. Using T3 Code? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` (upstream) or `fork-v*.*.*` (Pi + OMP) for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` for either channel
- Runs quality gates first: lint, typecheck, test.
- Reads the shared production T3 Connect relay URL and Clerk client configuration for the upstream
  profile. The fork profile uses the isolated `fork-release` environment and does not deploy shared
  relay or hosted-web infrastructure.
- Builds five artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Linux `arm64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Builds the profile-selected CLI package (`apps/server`; `t3` for upstream or `t3-pi-omp` for
  `pi-omp`):
  - upstream releases publish to npm with OIDC provenance
  - fork releases always attach a locally packed tarball to GitHub and publish to npm only when the
    repository variable `T3_PI_OMP_PUBLISH_NPM=true`
  - stable npm releases use dist-tag `latest`; nightly npm releases use `nightly`
  - fork background-service installs and self-updates fetch the same GitHub tarball, verify both
    `RELEASE-MANIFEST.json` and `SHA256SUMS`, then install from the verified local archive
- Deploys the hosted web app to Vercel only for the upstream profile after publication:
  - stable releases are aliased to the `latest` hosted app channel
  - nightly releases are aliased to the `nightly` hosted app channel
- Signing is optional and auto-detected per platform from secrets, matching upstream behavior.

Fork releases use the same workflow with an isolated product profile:

- stable tags: `fork-vX.Y.Z`
- nightly tags: `fork-vX.Y.Z-nightly.DATE.RUN`
- npm package and binary: `t3-pi-omp`
- npm dist-tags: `latest` for stable and `nightly` for nightly
- desktop identity: `com.t3tools.t3code.piomp`, `t3code-pi-omp`, and
  `t3code-pi-omp-dev`

The upstream and fork products must never share package names, desktop schemes, bundle IDs, state
directories, or release tags.

The automated workflow also publishes `install.sh`, `RELEASE-MANIFEST.json`, and `SHA256SUMS`.
Desktop assets are signed when platform credentials are configured. GitHub release assets receive
build provenance attestations. Fork npm publication is an explicit opt-in.

### Published private release

The current owner-controlled stable release is
[`fork-v0.0.40`](https://github.com/kmccleary3301/t3code/releases/tag/fork-v0.0.40), built from
`325c909d73d59dcfd912449a90d7987268aa3b29`. Its installer SHA-256 is
`ff5b3bbceacd7196b3bb06e75aa2a1afa010ce38bea88574182fc9043537ef3e`, its release-manifest
SHA-256 is `8f2f35cf08589da827951db2b10b9f203bcf9cfdc7a40a37134c5d926e2f622d`, and its
`t3-pi-omp-0.0.40.tgz` SHA-256 is
`4e48b1a3ab947c20443a8ad19c2a044d840bab82c766e91012546e1df1bdb85d`.

Release workflow run
[`32443000151`](https://github.com/kmccleary3301/t3code/actions/runs/32443000151) passed preflight,
all five desktop builds, local fork CLI packaging, provenance attestation, and GitHub publication.
The release contains macOS arm64/x64 DMG and ZIP artifacts, Linux arm64/x64 AppImages, a Windows
x64 NSIS installer, the CLI tarball, updater metadata, the installer, manifest, and checksums. No
optional Pi/OMP runtime bundles were configured.

GitHub attests the published release assets, but platform signing credentials were not configured.
The desktop artifacts are therefore unsigned and the macOS artifacts are unnotarized. Fork npm
publication remains disabled; the checksummed GitHub tarball is the authoritative CLI package.

`fork-v0.0.39` is superseded: its published installer could not infer the platform from
Electron-style desktop asset names that omitted `darwin` or `linux`. `fork-v0.0.40` records explicit
platform and architecture metadata and keeps a filename-compatible selector for older manifests.

### Optional Pi/OMP runtime bundles

The private release repository may set `T3_PI_OMP_RUNTIME_BUNDLES_JSON` as a repository variable.
It must contain:

```json
{
  "bundles": [
    {
      "provider": "pi",
      "platform": "darwin",
      "arch": "arm64",
      "url": "https://downloads.example.test/pi-runtime-darwin-arm64.tar.gz",
      "sha256": "<64 lowercase hexadecimal characters>"
    }
  ]
}
```

Provide both `pi` and `omp` entries for every shipped macOS/Linux architecture when the release is
intended to be self-contained. Each supplied bundle requires an HTTPS URL, exact SHA-256 digest,
deterministic archive name, duplicate-free provider identity, a 512 MiB per-archive limit, and
checksum verification before upload. Partial and unset configurations remain valid because native
runtimes are optional and may be managed by the user. This keeps native provider installation
opt-in and prevents replacing user-managed `pi` or `omp` binaries.

After publishing, verify the generated manifest contains `kind: "runtime"` entries with matching
`runtime`, `platform`, `arch`, and SHA-256 fields. Configure the emitted `PI_BINARY_PATH` and
`OMP_BINARY_PATH` values explicitly in the Pi/OMP provider settings; the installer never mutates
native configuration.

## Required release credentials

Upstream stable releases require these GitHub Actions secrets in addition to the platform and
deployment credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The upstream finalize job uses them to commit and push aligned package versions to `main` as the
Release App. Fork releases skip this upstream-only finalization; update the versioned package files
in the release-preparation commit. GitHub Release publication uses the repository-scoped workflow
token.

## T3 Connect relay deployment (upstream only)

The relay is a shared upstream control plane versioned separately from client releases. Stable and
nightly upstream clients use the same relay so linked environments remain available across channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` for upstream `main`. In the
owner-controlled fork it skips unless `T3_ENABLE_RELAY_DEPLOY=true`. Upstream releases read relay
and Clerk client configuration from the `production` environment. Fork releases use the isolated
`fork-release` environment, leave those values blank, and do not deploy relay or hosted-web
infrastructure.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The `prod` stage owns the retained PlanetScale
database. Local personal stages provision isolated branches from it and are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

## Hosted web app release deployment (upstream only)

The hosted app is intentionally not deployed by Vercel's Git integration. The
web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`, and the upstream path in `.github/workflows/release.yml` deploys
the web app with Vercel CLI after the GitHub Release succeeds. Fork releases skip this job.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3CODE_WEB_ROUTER_URL`: defaults to `https://app.t3.codes`.
- `T3CODE_WEB_LATEST_DOMAIN`: defaults to `latest.app.t3.codes`.
- `T3CODE_WEB_NIGHTLY_DOMAIN`: defaults to `nightly.app.t3.codes`.

Required Vercel domains:

- `app.t3.codes`: the router domain users open, updated by stable releases.
- `latest.app.t3.codes`: channel alias updated by stable releases.
- `nightly.app.t3.codes`: channel alias updated by nightly releases.

The router domain uses `apps/web/vercel.ts` routes. Users opt into a channel by
visiting `/__t3code/channel?channel=latest` or
`/__t3code/channel?channel=nightly`; the router stores the
`t3code_web_channel` cookie and rewrites future requests on `app.t3.codes` to
the matching channel alias.

The release deploy job rewrites release package versions before upload so the
hosted app's About panel renders the release version. Stable deploys alias the
same deployment to both the `latest` channel and the router domain so the router
rules stay current. Nightly deploys only alias the `nightly` channel. The job
also passes `VITE_HOSTED_APP_CHANNEL=latest|nightly`, which renders the hosted
update track selector in the About panel. Changing the selector navigates
through `/__t3code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

One-time Vercel dashboard setup:

1. Confirm the web project root directory remains `apps/web`.
2. Add the three domains above to the web project.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the dashboard is also safe.
4. Run one stable release deployment, or manually alias the current stable deployment, so
   `app.t3.codes` points at a deployment containing the router rules in `apps/web/vercel.ts`.
   Future stable releases keep this alias current.

## Nightly builds

Nightly builds are scheduled every three hours when `main` has changed since the previous nightly,
or can be started manually with `workflow_dispatch`.

- Workflow: `.github/workflows/release.yml`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on
  `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop
  users can opt into that track independently from stable.
- Publishes `t3` to the `nightly` npm dist-tag for upstream. Fork nightlies publish
  `t3-pi-omp` to npm only when `T3_PI_OMP_PUBLISH_NPM=true`; otherwise they attach the exact
  profile-specific tarball to the GitHub Release.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to a moving dist-tag. Every released
client version must therefore expose the matching profile-selected package through its configured
distribution channel:

- upstream and npm-enabled fork releases use the exact npm package version;
- default fork releases use the exact `t3-pi-omp` tarball in the matching GitHub Release, verified
  against both `RELEASE-MANIFEST.json` and `SHA256SUMS`.

The workflow enforces this ordering:

1. `publish_cli` either publishes the exact package to npm or packs the fork tarball locally.
2. `release` depends on `publish_cli`, verifies and publishes the tarball plus release metadata,
   then exposes desktop artifacts.
3. The upstream-only `deploy_web` job depends on `release` before moving the hosted channel.

Preserve these dependencies when changing the release graph. Publishing a client before its exact
server package would leave **Update server** without a verifiable target.

For an upstream or npm-enabled fork smoke test, confirm
`npm view <package>@<version> version` returns the expected version. For a default fork release,
download the matching tarball, `RELEASE-MANIFEST.json`, and `SHA256SUMS`; verify both recorded
digests, then exercise installation from the verified local archive. Connect the new client to a
server on the previous version and verify that the update action reconnects to the exact server.
Use releases with identical migration manifests for the automatic path. When the manifest changed,
verify that the remote action stops before restart and shows the exact local package command. Also
test the manual or desktop-managed guidance when those environments are available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. WSL cannot read ASAR files, so enabling
the WSL backend extracts the server tree once into the desktop state directory
under `wsl-server-tree/<version>` and reuses the completed version until the app
is updated.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow invokes `node apps/server/scripts/cli.ts publish` after aligning package versions. That
script temporarily prepares the profile-selected package (`t3` or `t3-pi-omp`), then runs
`vp pm publish --filter <selected-package> ...` from the repository root so workspace publish
configuration is applied correctly. npm provenance is enabled in CI through OIDC.

Checklist:

1. Confirm npm org/user owns `t3` and, when fork npm publication is enabled, `t3-pi-omp`.
2. In each published package's settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing and provenance.
4. For fork npm publication, set repository variable `T3_PI_OMP_PUBLISH_NPM=true`. Leave it unset
   until the package and trusted publisher exist; the workflow still publishes a checksummed GitHub
   Release tarball.
5. Create release tag `vX.Y.Z` or `fork-vX.Y.Z` and push. The workflow aligns release package
   versions, builds web + server, and either publishes to npm with provenance or packs the fork CLI
   locally.
6. Nightly runs use the same profile-specific behavior and npm dist-tag `nightly` when npm is
   enabled.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1` or `fork-v0.0.0-test.1`, classifies the run as stable and creates a real GitHub
Release. Upstream additionally publishes npm, deploys the hosted app, and may commit a version bump.
Fork releases publish a local CLI tarball by default; npm is used only when
`T3_PI_OMP_PUBLISH_NPM=true`. Do not push a test tag to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. Manually dispatching `channel=nightly` still creates a
real nightly GitHub prerelease and desktop updater release. Upstream also publishes npm and deploys
the hosted nightly alias; fork npm publication remains opt-in. Only run it when a real nightly
release is acceptable.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from the production Clerk publishable key.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID and enable Associated Domains:
   - upstream profile: `com.t3tools.t3code`
   - fork profile: `com.t3tools.t3code.piomp`
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for the
   selected profile's App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [T3 Connect Clerk Setup](../internals/t3-connect.md#desktop-passkeys).
11. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create the profile-specific release tag: `vX.Y.Z` or `fork-vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - `publish_cli` produces the exact release-version tarball and publishes npm only when configured
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to the selected profile's App ID
    (`APPLE_TEAM_ID.com.t3tools.t3code` or `APPLE_TEAM_ID.com.t3tools.t3code.piomp`) and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
