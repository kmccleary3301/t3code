# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with seven entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |
| `pi`          | [`Drivers/PiDriver.ts`][pi]             |
| `omp`         | [`Drivers/OmpDriver.ts`][omp]           |

Pi and Oh My Pi use separate driver kinds and settings schemas, while sharing the native Pi-family
adapter boundary. Each instance keeps its configured binary, agent directory, environment, launch
arguments, trust mode, and request limits. A Pi instance never launches the OMP driver, and vice
versa.

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Managing existing Pi-family sessions

The web command palette and mobile **Native Sessions** sheet discover durable Pi and OMP sessions
from every connected environment with an enabled, installed Pi-family provider instance.
[`NativeSessionCatalog`][native-catalog] reads each instance's primary session files across their
recorded working directories; nested subagent transcripts stay out of the catalog. Session directory
resolution honors `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, the configured agent directory or
`PI_CODING_AGENT_DIR`, OMP profiles, then the runtime default under `~/.pi/agent/sessions` or
`~/.omp/agent/sessions`.

Attachment is one atomic server operation. [`NativeSessionCoordinator`][native-coordinator] resolves
or registers the project for the session's normalized working directory, claims a deterministic T3
thread for the provider-instance/session pair, starts one native process, reconciles JSONL history,
and returns both IDs. A server semaphore serializes competing lifecycle requests; the persisted
provider binding and deterministic thread ID preserve ownership across reconnects and host restarts.
Pi resumes the exact ID with `--session`; OMP uses `--resume`.
An unavailable recorded working directory fails before process spawn instead of leaving an attachment
request pending.

History reconciliation follows the active JSONL parent chain and projects user, system, and assistant
text through `thread.native-history-imported`. Message and turn IDs are deterministic and projection
writes are upserts, so reopening imports newly appended history without duplicating prior transcript
records. Native tool records remain owned by the native runtime; later live events use the normal
canonical thread pipeline.

Rename and fork use each runtime's RPC lifecycle commands. Forking rebinds the native process, so the
coordinator stops the source attachment before opening the returned session ID as its own T3 thread.
Stop terminates only the T3-owned live process. **Archive thread** rejects an active turn, then stops
the T3-owned process and archives the canonical thread. Neither Pi nor OMP exposes a safe native
archive/delete RPC, so T3 never rewrites, moves, or deletes session JSONL files.

All six RPCs—list, open, rename, fork, stop, and archive—live in the shared client runtime. Once
attached, a native session is an ordinary canonical thread: mobile can send turns, interrupt work,
answer approvals and user-input requests, change supported runtime/model settings, and receive the
existing thread push notifications without a provider-specific notification path.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[pi]: ../../apps/server/src/provider/Drivers/PiDriver.ts
[omp]: ../../apps/server/src/provider/Drivers/OmpDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[native-catalog]: ../../apps/server/src/provider/piFamily/NativeSessionCatalog.ts
[native-coordinator]: ../../apps/server/src/provider/Layers/NativeSessionCoordinator.ts
