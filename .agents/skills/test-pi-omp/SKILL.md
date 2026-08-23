---
name: test-pi-omp
description: Validate Pi and Oh My Pi provider integration through scrubbed native replay, deterministic transfer budgets, authenticated multi-client convergence, isolated private canaries, and release checks without touching shared user state.
---

# Test Pi and OMP

Pi and OMP are separate provider kinds. Use provider-specific fixtures and assertions; never substitute one runtime for the other.

## Focused deterministic proof

From the repository root:

```sh
vp test run apps/server/src/provider/piFamily/NativeTraceCorpus.test.ts apps/server/src/provider/piFamily/NativeTraceReplay.test.ts
vp test run apps/server/integration/TransferBudgetReport.integration.test.ts
vp test run apps/server/src/server.test.ts -t "reports thread HTTP and WebSocket transfer budgets"
vp test run apps/server/src/server.test.ts -t "keeps authenticated thread subscribers converged across bounded reconnect replay"
```

Native fixtures are scrubbed structural subjects. Inspect provenance, source/binary hashes, redaction status, frame bounds, and leak-scan output before accepting a fixture. Raw captures belong only in mode-0700 temporary directories with mode-0600 files.

## Real-process and authenticated checks

Use pinned binaries and disposable worktree state. Record exact runtime version, resolved executable, binary hash, protocol/capability negotiation, root-turn result, projected state, and exit/cleanup result. Keep credentials in supported local stores; never place them in fixtures, logs, screenshots, or reports.

A direct native CLI turn does not prove T3 integration. The authenticated proof must observe HTTP bootstrap, WebSocket projection, persistence, and the client-visible result. If credentials, a broker, a target host, or a runtime binary is unavailable, record the exact limitation instead of claiming support.

## Multi-client convergence

Use the real authenticated HTTP and permessage-deflate WebSocket paths with typed receipt waits and bounded queue waits. Exercise Pi and OMP separately. Start clients from different snapshot sequences, disconnect/reconnect from the last acknowledged sequence, and compare canonical messages, tasks, checkpoints, terminal state, and durable event IDs. Always interrupt fibers and dispose the harness; verify no owned native process remains.

## Private canary

Never start a server against `~/.t3/userdata` and never mutate it. Stop writers, snapshot with `VACUUM INTO` into a mode-0700 disposable directory, migrate/reproject copies only, hash source before and after, and emit aggregate-only evidence. Remove temporary databases and raw logs after the canary unless the user explicitly requests retention.

Run the opt-in canary only with an explicit source and output directory:

```sh
vp run private-state-canary --source /absolute/path/to/state.sqlite --output-dir /tmp/t3-private-canary
```

Public CI does not run the private canary or access credentials.

## Release checks

Before a release claim, run `node scripts/release-security-check.ts`, `node scripts/release-smoke.ts`, and the installer tests. Tie every manifest/checksum/artifact result to the exact release tag and commit. State unsigned/unnotarized and unexercised platform limitations plainly.
