// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";

import ompRootFixture from "./testFixtures/native/omp-17.3.7-root.json" with { type: "json" };
import ompFixture from "./testFixtures/native/omp-17.3.7.json" with { type: "json" };
import piRootFixture from "./testFixtures/native/pi-0.84.2-root.json" with { type: "json" };
import piFixture from "./testFixtures/native/pi-0.84.2.json" with { type: "json" };
import {
  normalizeNativeTrace,
  validateNativeTraceCorpus,
  type NativeTraceCaptureEnvelope,
} from "./NativeTrace.ts";
import { PiFamilyEventProjector } from "./PiFamilyEventProjector.ts";
import {
  OmpChunkAssembler,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
} from "./OmpChunkAssembler.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";
import { parseJsonObject, type RpcEnvelope } from "./protocol.ts";
const MAX_COMMITTED_FIXTURE_BYTES = 1024 * 1024;
const MAX_DECOMPRESSED_FIXTURE_BYTES = 4 * 1024 * 1024;
const loadCompressedFixture = (
  fileName: string,
): { readonly bytes: Buffer; readonly decompressed: Buffer; readonly fixture: unknown } => {
  const bytes = NodeFS.readFileSync(new URL(`./testFixtures/native/${fileName}`, import.meta.url));
  const decompressed = NodeZlib.gunzipSync(bytes, {
    maxOutputLength: MAX_DECOMPRESSED_FIXTURE_BYTES,
  });
  return { bytes, decompressed, fixture: JSON.parse(decompressed.toString("utf8")) };
};
const chunkedCompressed = loadCompressedFixture("omp-17.3.7-chunked.json.gz");
const hierarchyCompressed = loadCompressedFixture("omp-17.3.7-hierarchy.json.gz");
const cancellationCompressed = loadCompressedFixture("omp-17.3.7-cancellation.json.gz");
const reconnectCompressed = loadCompressedFixture("omp-17.3.7-reconnect.json.gz");
const checkpointsCompressed = loadCompressedFixture("omp-17.3.7-checkpoints.json.gz");
const unknownCompressed = loadCompressedFixture("omp-17.3.7-unknown.json.gz");
const piPromptCompressed = loadCompressedFixture("pi-0.84.2-prompt-lifecycle.json.gz");
const piFramingCompressed = loadCompressedFixture("pi-0.84.2-framing-failure.json.gz");
const piCheckpointsCompressed = loadCompressedFixture("pi-0.84.2-checkpoints.json.gz");
const piSessionCompactionCompressed = loadCompressedFixture(
  "pi-0.84.2-session-compaction-restart.json.gz",
);
const piSemanticTasksCompressed = loadCompressedFixture("pi-0.84.2-semantic-host-tasks.json.gz");
const piPortableUiCompressed = loadCompressedFixture("pi-0.84.2-portable-extension-ui.json.gz");
const compressedFixtures = [
  chunkedCompressed,
  hierarchyCompressed,
  cancellationCompressed,
  reconnectCompressed,
  unknownCompressed,
  checkpointsCompressed,
  piPromptCompressed,
  piFramingCompressed,
  piCheckpointsCompressed,
  piSessionCompactionCompressed,
  piSemanticTasksCompressed,
  piPortableUiCompressed,
] as const;
const ompChunkedFixture = chunkedCompressed.fixture;
const ompHierarchyFixture = hierarchyCompressed.fixture;
const ompCancellationFixture = cancellationCompressed.fixture;
const ompReconnectFixture = reconnectCompressed.fixture;
const ompUnknownFixture = unknownCompressed.fixture;
const ompCheckpointsFixture = checkpointsCompressed.fixture;
const piPromptFixture = piPromptCompressed.fixture;
const piFramingFixture = piFramingCompressed.fixture;
const piCheckpointsFixture = piCheckpointsCompressed.fixture;
const piSessionCompactionFixture = piSessionCompactionCompressed.fixture;
const piSemanticTasksFixture = piSemanticTasksCompressed.fixture;
const piPortableUiFixture = piPortableUiCompressed.fixture;
const committedJsonFixtures = [piFixture, ompFixture, piRootFixture, ompRootFixture] as const;
const OMP_READY_FRAME_REQUIRED = new Set([
  "omp-17.3.7-native-handshake",
  "omp-17.3.7-native-task-hierarchy",
  "omp-17.3.7-native-unknown-command",
  "omp-17.3.7-native-session-reconnect",
  "omp-17.3.7-native-checkpoints",
]);
const committedFixtures = [
  ...committedJsonFixtures,
  ompChunkedFixture,
  ompHierarchyFixture,
  ompCancellationFixture,
  ompReconnectFixture,
  ompCheckpointsFixture,
  ompUnknownFixture,
  piPromptFixture,
  piFramingFixture,
  piCheckpointsFixture,
  piSessionCompactionFixture,
  piSemanticTasksFixture,
  piPortableUiFixture,
] as const;
const fixtures = validateNativeTraceCorpus(committedFixtures);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reviewedProvenance: Readonly<
  Record<
    string,
    {
      readonly runtime: "pi" | "omp";
      readonly version: string;
      readonly revision: string;
      readonly sourceSha256: string;
      readonly exitCode: number | null;
    }
  >
> = {
  "pi-0.84.2-native-handshake": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:bffdb3b169c487e8c6dee9db0f92ae0fdac7c995e76f8865cea26f9f1ed2c4ed",
    sourceSha256: "bffdb3b169c487e8c6dee9db0f92ae0fdac7c995e76f8865cea26f9f1ed2c4ed",
    exitCode: 143,
  },
  "omp-17.3.7-native-handshake": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c7609f9b16802fdc01d40ebd184e1efb86067e89bafb770430c8ddf6dca074c0",
    sourceSha256: "c7609f9b16802fdc01d40ebd184e1efb86067e89bafb770430c8ddf6dca074c0",
    exitCode: 143,
  },
  "pi-0.84.2-native-root": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "59578880c56c556236508f3b3a63b7269addb9cf867c0dd9f31e22d6bf6e3f50",
    exitCode: 143,
  },
  "omp-17.3.7-native-root": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c1434d85392024aab964220b3c3fd27afe1241d13d5488dac84b489d1f052b0d",
    sourceSha256: "8821372065d89a7a4750e10b38bd60691b1e3e37fb5fb49857f971936e0c3408",
    exitCode: 143,
  },
  "omp-17.3.7-native-chunked-models": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c1434d85392024aab964220b3c3fd27afe1241d13d5488dac84b489d1f052b0d",
    sourceSha256: "9b5238104b55a7dcd6057b28521704c5ad5fd8eb45ff6c3e11b820a6824cbfd5",
    exitCode: 0,
  },
  "omp-17.3.7-native-task-hierarchy": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c1434d85392024aab964220b3c3fd27afe1241d13d5488dac84b489d1f052b0d",
    sourceSha256: "f54496c4a1d7168ba85db69c0b08a120b46263683161b180242790c5495ea794",
    exitCode: 0,
  },
  "omp-17.3.7-native-task-cancellation": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c1434d85392024aab964220b3c3fd27afe1241d13d5488dac84b489d1f052b0d",
    sourceSha256: "bcdef2efc96d2e78c97b12c4da61e301d5a246ed5967a24beba6f0f92ecd33c5",
    exitCode: 0,
  },
  "omp-17.3.7-native-session-reconnect": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:b6d0a3a579a92f7432035409eefbbe90c454d3b1c30aa4e33125d4e81614334d",
    sourceSha256: "ab5beef873a4928c6daaa7257568906e78bba6a27e4f573204d8a9a8089cbad8",
    exitCode: 0,
  },
  "omp-17.3.7-native-checkpoints": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:1ff2bbb374ddab80fd7a26893fa2f9aa8e18da9816f52d7eb92b2c729253aab7",
    sourceSha256: "1b12445e0c0cdf6c0d723d217e4322d94e6265c2a54ca64d86c8b2d9b4222b13",
    exitCode: 0,
  },
  "omp-17.3.7-native-unknown-command": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:1ff2bbb374ddab80fd7a26893fa2f9aa8e18da9816f52d7eb92b2c729253aab7",
    sourceSha256: "60e9aeff05b5e71cc788de00ea5e83bcd361f3fbbcf081f21dcd2a6d85386bcd",
    exitCode: 0,
  },
  "pi-0.84.2-native-prompt-lifecycle": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "037fb55ee951e705563e7929ff6c917c6d87faa36f5beb80fdfaeee1b1d7f876",
    exitCode: 0,
  },
  "pi-0.84.2-native-framing-failure": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "ed394f10d9e1e17cd677cb5c8eedd18a45c0c73387a7faa499ee1837ae5d9492",
    exitCode: 0,
  },
  "pi-0.84.2-native-checkpoints": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "a792eeb0dae0003ed50c357be0621d668346221258d2de1a20f8a31f5a40e03a",
    exitCode: 0,
  },
  "pi-0.84.2-native-session-compaction-restart": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "f625732b56532f4e786d682554a37228a2c1581c592a0998d90e1bb34562db9b",
    exitCode: 0,
  },
  "pi-0.84.2-native-semantic-host-tasks": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "3a735ecdb95cc8823dfa14128586151f818a059d2d8eae533c6f839f0d9e0333",
    exitCode: 0,
  },
  "pi-0.84.2-native-portable-extension-ui": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "062d5b778c857c55fa752f2d2de421129f4914f2d91bbcfe9829507969d5c78b",
    exitCode: 0,
  },
};

function replayStdout(fixture: NativeTraceCaptureEnvelope): ReadonlyArray<RpcEnvelope> {
  const decoder = new StrictJsonlDecoder(1_048_576);
  const assembler = fixture.manifest?.runtime.kind === "omp" ? new OmpChunkAssembler() : undefined;
  const frames: RpcEnvelope[] = [];
  const consume = (line: string): void => {
    const frame = parseJsonObject(line);
    const assembled = assembler ? assembler.accept(frame) : frame;
    if (assembled !== undefined) frames.push(assembled);
  };

  for (const chunk of [...fixture.capture.chunks].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    if (chunk.stream !== "stdout") continue;
    for (const line of decoder.push(NodeBuffer.Buffer.from(chunk.bytesBase64, "base64"))) {
      consume(line);
    }
  }
  for (const line of decoder.finish()) consume(line);
  assert.equal(assembler?.pendingMessageCount ?? 0, 0);
  return frames;
}

describe("checked-in native trace corpus", () => {
  it("keeps every committed fixture below the review ceiling", () => {
    for (const fixture of committedJsonFixtures) {
      assert.isAtMost(
        new TextEncoder().encode(encodeUnknownJson(fixture)).byteLength,
        MAX_COMMITTED_FIXTURE_BYTES,
      );
    }
    for (const compressed of compressedFixtures) {
      assert.isAtMost(compressed.bytes.byteLength, MAX_COMMITTED_FIXTURE_BYTES);
      assert.isAtMost(compressed.decompressed.byteLength, MAX_DECOMPRESSED_FIXTURE_BYTES);
    }
  });
  it("accepts only reviewed, exact-binary Pi and OMP captures", () => {
    assert.deepEqual(
      fixtures.map((fixture) => fixture.manifest?.runtime.kind),
      [
        "pi",
        "omp",
        "pi",
        "omp",
        "omp",
        "omp",
        "omp",
        "omp",
        "omp",
        "omp",
        "pi",
        "pi",
        "pi",
        "pi",
        "pi",
        "pi",
      ],
    );

    for (const fixture of fixtures) {
      const manifest = fixture.manifest;
      assert.isDefined(manifest);
      assert.isFalse(manifest.fixture.synthetic);
      const provenance = reviewedProvenance[manifest.fixture.id];
      assert.isDefined(provenance);
      assert.equal(manifest.runtime.kind, provenance.runtime);
      assert.equal(manifest.runtime.version, provenance.version);
      assert.equal(manifest.runtime.revision, provenance.revision);
      assert.equal(manifest.provenance.sourceSha256, provenance.sourceSha256);
      assert.isTrue(manifest.redaction.reviewed);
      assert.isTrue(manifest.redaction.leakScanPassed);
      assert.deepEqual(manifest.redaction.unknownPaths, []);
      assert.isFalse(fixture.capture.truncated);
      if (manifest.fixture.id.endsWith("-native-root")) {
        assert.isAbove(manifest.redaction.report.redactedPaths.length, 0);
      }
    }
  });

  it("replays exact sanitized chunks through production framing and assembly", () => {
    for (const fixture of fixtures) {
      const manifest = fixture.manifest;
      assert.isDefined(manifest);
      const reviewed = reviewedProvenance[manifest.fixture.id];
      assert.isDefined(reviewed);
      const frames = replayStdout(fixture);
      const expected = manifest.expectedOutcome.value as {
        readonly adapterEventTypes?: ReadonlyArray<string>;
        readonly eventTypes?: ReadonlyArray<string>;
        readonly canonicalLifecycle?: ReadonlyArray<"turn.started" | "turn.settled">;
        readonly exit: {
          readonly code: number | null;
          readonly sequence: number;
          readonly signal: string | null;
        };
        readonly frameTypes?: ReadonlyArray<string>;
        readonly rawFrameTypes?: ReadonlyArray<string>;
        readonly responseCommands?: ReadonlyArray<string>;
        readonly status?: string;
        readonly outputMarker?: string;
        readonly teardownObservation?: string;
        readonly chunkId?: string;
        readonly chunkCount?: number;
        readonly byteLength?: number;
        readonly modelCount?: number;
        readonly subagentFrames?: {
          readonly lifecycle: number;
          readonly progress: number;
          readonly event: number;
        };
        readonly canonicalSettlement?: { readonly started: number; readonly completed: number };
        readonly toolEvents?: {
          readonly started: number;
          readonly progress: number;
          readonly completed: number;
        };
        readonly uiRequests?: number;
        readonly turnStarted?: number;
        readonly turnSettled?: number;
        readonly subagentLifecycleStatuses?: ReadonlyArray<string>;
        readonly cancelResponse?: { readonly success: boolean; readonly cancelled: boolean };
        readonly newSessionAck?: { readonly success: boolean; readonly cancelled: boolean };
        readonly availableCommandsUpdatesAfterNewSession?: number;
        readonly agentEnds?: number;
        readonly compaction?: {
          readonly compactSuccess: boolean;
          readonly compactionStarts: number;
          readonly compactionEnds: number;
          readonly compactionEndAborted: boolean | null;
          readonly hasCompactionEntry: boolean;
          readonly entryTypes: ReadonlyArray<string>;
          readonly restartCount: number | null;
          readonly restartAccepted: boolean;
          readonly sessionIdentityPreserved: boolean;
        };
        readonly hostFrames?: ReadonlyArray<string>;
        readonly childStatuses?: ReadonlyArray<string>;
        readonly parentStatuses?: ReadonlyArray<string>;
        readonly projectedKinds?: ReadonlyArray<string>;
        readonly hasToolFrames?: boolean;
        readonly uiMethods?: ReadonlyArray<string>;
        readonly responseKinds?: ReadonlyArray<string>;
        readonly capabilityFallbacks?: ReadonlyArray<string>;
        readonly customUiFrame?: boolean;
        readonly factoryUiFrames?: boolean;
      };
      assert.deepEqual(
        frames.map((frame) => frame.type),
        [...(expected.rawFrameTypes ?? expected.frameTypes ?? [])],
      );
      assert.deepEqual(fixture.capture.exits, [expected.exit]);
      assert.equal(expected.exit.sequence, fixture.capture.totalEvents - 1);
      assert.isBelow(
        Math.max(...fixture.capture.chunks.map((chunk) => chunk.sequence)),
        expected.exit.sequence,
      );
      assert.equal(expected.exit.code, reviewed.exitCode);
      assert.isNull(expected.exit.signal);
      const serializedFrames = JSON.stringify(frames);
      assert.notInclude(serializedFrames, "pocock-");
      assert.notInclude(serializedFrames, "/Users/");
      for (const frame of frames.filter((frame) => frame.type === "available_commands_update")) {
        assert.deepEqual(frame.commands, []);
      }
      if (manifest.runtime.kind === "omp") {
        const ready = frames.find((frame) => frame.type === "ready");
        if (OMP_READY_FRAME_REQUIRED.has(manifest.fixture.id)) assert.isDefined(ready);
        if (ready) {
          assert.equal(ready.protocolVersion, 1);
          if (!Array.isArray(ready.supportedProtocolVersions))
            throw new TypeError(
              "Expected OMP ready frame to advertise supported protocol versions",
            );
          assert.isTrue(ready.supportedProtocolVersions.includes(2));
          assert.equal(ready.maxFrameBytes, OMP_MAX_FRAME_BYTES);
          assert.equal(ready.maxReassembledFrameBytes, OMP_MAX_REASSEMBLED_BYTES);
        }
      }
      if (expected.responseCommands !== undefined) {
        assert.deepEqual(
          frames.filter((frame) => frame.type === "response").map((frame) => frame.command),
          [...expected.responseCommands],
        );
      }
      if (manifest.fixture.id === "omp-17.3.7-native-chunked-models") {
        assert.equal(expected.status, "chunked-models-complete");
        assert.equal(expected.chunkId, "rpc-1");
        assert.equal(expected.modelCount, 695);
        assert.equal(expected.chunkCount, 5);
        assert.deepEqual(
          fixture.capture.chunks.map((chunk) => chunk.byteLength),
          [349_618, 349_618, 349_618, 349_618, 141_922],
        );
        const chunkFrames = fixture.capture.chunks.map((chunk) =>
          parseJsonObject(NodeBuffer.Buffer.from(chunk.bytesBase64, "base64").toString("utf8")),
        );
        assert.deepEqual(
          chunkFrames.map((frame) => frame.index),
          [0, 1, 2, 3, 4],
        );
        assert.isTrue(
          chunkFrames.every(
            (frame) =>
              frame.type === "rpc_chunk" &&
              frame.chunkId === expected.chunkId &&
              frame.count === expected.chunkCount &&
              frame.byteLength === expected.byteLength,
          ),
        );
        assert.lengthOf(frames, 1);
        const response = frames[0];
        if (!response) throw new TypeError("Expected one reassembled OMP response");
        assert.equal(
          NodeBuffer.Buffer.byteLength(JSON.stringify(response), "utf8"),
          expected.byteLength,
        );
        if (typeof response.data !== "string")
          throw new TypeError("Expected the reassembled OMP response data to be redacted text");
        assert.isTrue(response.data.startsWith("[REDACTED]"));
      }
      if (manifest.fixture.id === "omp-17.3.7-native-task-cancellation") {
        assert.equal(expected.status, "cancellation-complete");
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        const kinds = projected.map((event) => event.kind);
        assert.equal(
          kinds.filter((kind) => kind === "task.started").length,
          expected.canonicalSettlement?.started,
        );
        assert.equal(
          kinds.filter((kind) => kind === "task.completed").length,
          expected.canonicalSettlement?.completed,
        );
        assert.equal(kinds.filter((kind) => kind === "turn.started").length, expected.turnStarted);
        assert.equal(kinds.filter((kind) => kind === "turn.settled").length, expected.turnSettled);
        assert.equal(projected.at(-1)?.kind, "turn.settled");
        const lifecycleFrames = frames.filter((frame) => frame.type === "subagent_lifecycle");
        assert.deepEqual(
          lifecycleFrames.map((frame) =>
            typeof frame.payload === "object" && frame.payload !== null
              ? (frame.payload as { readonly status?: unknown }).status
              : undefined,
          ),
          [...(expected.subagentLifecycleStatuses ?? [])],
        );
        const cancelRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .filter((request) => request.type === "cancel_task"),
          );
        assert.lengthOf(cancelRequests, 1);
        const cancelRequest = cancelRequests[0];
        if (!cancelRequest) throw new TypeError("Expected one cancel_task stdin request");
        const startedLifecycle = lifecycleFrames.find(
          (frame) =>
            typeof frame.payload === "object" &&
            frame.payload !== null &&
            (frame.payload as { readonly status?: unknown }).status === "started",
        );
        if (!startedLifecycle || typeof startedLifecycle.payload !== "object")
          throw new TypeError("Expected a started subagent lifecycle payload");
        assert.equal(cancelRequest.taskId, startedLifecycle.payload.id);
        const cancelResponse = frames.find(
          (frame) => frame.type === "response" && frame.command === "cancel_task",
        );
        assert.isDefined(cancelResponse);
        assert.isTrue(cancelResponse.success);
        assert.equal(cancelResponse.id, cancelRequest.id);
        const snapshots = projector.snapshotTasks();
        assert.lengthOf(snapshots, 1);
        assert.equal(projector.diagnostics().activeTasks, 0);
        const cancelledChild = snapshots[0];
        if (!cancelledChild) throw new TypeError("Expected one cancelled OMP child task snapshot");
        assert.equal(cancelledChild.status, "cancelled");
        const spawnFrame = frames.find(
          (frame) => frame.type === "tool_execution_start" && frame.toolName === "task",
        );
        assert.isDefined(spawnFrame);
        assert.equal(cancelledChild.parentToolCallId, spawnFrame.toolCallId);
      }
      if (manifest.fixture.id === "omp-17.3.7-native-session-reconnect") {
        assert.equal(expected.status, "reconnect-complete");
        const newSessionRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .filter((request) => request.type === "new_session"),
          );
        assert.lengthOf(newSessionRequests, 1);
        const newSessionResponse = frames.find(
          (frame) => frame.type === "response" && frame.command === "new_session",
        );
        assert.isDefined(newSessionResponse);
        assert.isTrue(newSessionResponse.success);
        assert.equal(newSessionResponse.id, newSessionRequests[0]?.id);
        // The captured wire shows the refresh landing between the last
        // pre-restart agent_end and the new_session response (the handler
        // emits the update while the session swap settles).
        const responseIndex = frames.indexOf(newSessionResponse);
        const updatesBeforeResponse = frames
          .slice(0, responseIndex)
          .filter((frame) => frame.type === "available_commands_update").length;
        assert.isAtLeast(updatesBeforeResponse, expected.availableCommandsUpdatesAfterNewSession);
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        const kinds = projected.map((event) => event.kind);
        assert.equal(
          kinds.filter((kind) => kind === "turn.started").length,
          expected.canonicalSettlement?.started,
        );
        assert.equal(
          kinds.filter((kind) => kind === "turn.settled").length,
          expected.canonicalSettlement?.completed,
        );
        assert.equal(projected.at(-1)?.kind, "turn.settled");
        assert.equal(
          frames.filter((frame) => frame.type === "agent_end" && frame.isTerminal === true).length,
          expected.agentEnds,
        );
        assert.equal(projector.diagnostics().activeTasks, 0);
      }
      if (manifest.fixture.id === "omp-17.3.7-native-checkpoints") {
        assert.equal(expected.status, "checkpoints-complete");
        const stdinRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>),
          );
        const snapshotRewinds = stdinRequests.filter(
          (request) => request.type === "rewind" && request.mode === "snapshot",
        );
        assert.lengthOf(snapshotRewinds, 1);
        // Identity correlation: the durable snapshot rewind carries the same
        // opaque checkpoint and session identifiers the checkpoint response
        // returned (tokenized identically on both sides of the wire).
        const checkpointRequests = stdinRequests.filter(
          (request) => request.type === "checkpoint" && request.mode === "snapshot",
        );
        assert.lengthOf(checkpointRequests, 1);
        const snapshotRewind = snapshotRewinds[0];
        assert.isDefined(snapshotRewind.checkpointId);
        assert.isDefined(snapshotRewind.sessionId);
        const checkpointResponses = frames.filter(
          (frame) => frame.type === "response" && frame.command === "checkpoint",
        );
        assert.lengthOf(checkpointResponses, 2);
        for (const response of checkpointResponses) assert.isTrue(response.success);
        const rewindResponses = frames.filter(
          (frame) => frame.type === "response" && frame.command === "rewind",
        );
        assert.lengthOf(rewindResponses, 3);
        assert.isTrue(rewindResponses[0]?.success);
        assert.isTrue(rewindResponses[1]?.success);
        assert.isFalse(rewindResponses[2]?.success);
        assert.equal(rewindResponses[2]?.code, "checkpoint_missing");
        const agentEnds = frames.filter(
          (frame) => frame.type === "agent_end" && frame.isTerminal === true,
        ).length;
        assert.equal(agentEnds, 4);
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        const kinds = projected.map((event) => event.kind);
        assert.equal(
          kinds.filter((kind) => kind === "turn.started").length,
          expected.canonicalSettlement?.started,
        );
        assert.equal(
          kinds.filter((kind) => kind === "turn.settled").length,
          expected.canonicalSettlement?.completed,
        );
        assert.equal(projector.diagnostics().activeTasks, 0);
      }
      if (manifest.fixture.id === "omp-17.3.7-native-unknown-command") {
        assert.equal(expected.status, "unknown-command-bounded");
        const stdinRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>),
          );
        const unknownRequest = stdinRequests.find(
          (request) => request.type === "definitely_not_a_real_command",
        );
        assert.isDefined(unknownRequest);
        const errorResponse = frames.find(
          (frame) =>
            frame.type === "response" &&
            frame.command === unknownRequest.type &&
            frame.success === false,
        );
        assert.isDefined(errorResponse);
        assert.equal(errorResponse.code, expected.failureResponse?.code);
        assert.isString(errorResponse.error);
        assert.include(String(errorResponse.error), "Unknown command");
        // The transport survives: a valid request after the failure still
        // receives its correlated success response on the same session.
        const livenessResponse = frames.find(
          (frame) => frame.type === "response" && frame.command === "get_capabilities",
        );
        assert.isDefined(livenessResponse);
        assert.isTrue(livenessResponse.success);
        assert.isAbove(frames.indexOf(livenessResponse), frames.indexOf(errorResponse));
        assert.equal(
          frames.filter((frame) => frame.type === "agent_end").length,
          expected.agentEnds,
        );
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        assert.equal(projector.diagnostics().activeTasks, 0);
      }
      if (manifest.fixture.id === "pi-0.84.2-native-prompt-lifecycle") {
        assert.equal(expected.status, "prompt-lifecycle-complete");
        const promptRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .filter((request) => request.type === "prompt"),
          );
        assert.lengthOf(promptRequests, 1);
        const promptResult = frames.find((frame) => frame.type === "prompt_result");
        assert.isDefined(promptResult);
        assert.equal((promptResult as { outcome?: string }).outcome, "started");
        const agentStart = frames.find((frame) => frame.type === "agent_start");
        assert.isDefined(agentStart);
        const turnStart = frames.find((frame) => frame.type === "turn_start");
        assert.isDefined(turnStart);
        const turnEnd = frames.find((frame) => frame.type === "turn_end");
        assert.isDefined(turnEnd);
        const settled = frames.filter((frame) => frame.type === "agent_settled");
        assert.lengthOf(settled, 1);
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        const kinds = projected.map((event) => event.kind);
        assert.equal(
          kinds.filter((kind) => kind === "turn.started").length,
          expected.canonicalSettlement?.started,
        );
        assert.equal(
          kinds.filter((kind) => kind === "turn.settled").length,
          expected.canonicalSettlement?.completed,
        );
        assert.equal(projector.diagnostics().activeTasks, 0);
      }
      if (manifest.fixture.id === "pi-0.84.2-native-framing-failure") {
        assert.equal(expected.status, "framing-failure-bounded");
        const stdinRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>),
          );
        const invalidRequest = stdinRequests.find(
          (request) => request.type === "bogus_command_type",
        );
        assert.isDefined(invalidRequest);
        const errorResponse = frames.find(
          (frame) =>
            frame.type === "response" &&
            frame.command === "bogus_command_type" &&
            frame.success === false,
        );
        assert.isDefined(errorResponse);
        assert.isString(errorResponse.error);
        assert.include(String(errorResponse.error), "Unknown command");
        const livenessResponse = frames.find(
          (frame) => frame.type === "response" && frame.command === "get_capabilities",
        );
        assert.isDefined(livenessResponse);
        assert.isTrue(livenessResponse.success);
        assert.isAbove(frames.indexOf(livenessResponse), frames.indexOf(errorResponse));
        assert.equal(frames.filter((frame) => frame.type === "agent_settled").length, 0);
      }
      if (manifest.fixture.id === "pi-0.84.2-native-checkpoints") {
        assert.equal(expected.status, "checkpoints-complete");
        const stdinRequests = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>),
          );
        const captureRequests = stdinRequests.filter(
          (request) => request.type === "capture_checkpoint",
        );
        assert.lengthOf(captureRequests, expected.checkpointCommands);
        const restoreRequests = stdinRequests.filter(
          (request) => request.type === "restore_checkpoint",
        );
        assert.lengthOf(restoreRequests, expected.restoreCommands);
        // The first restore attempt omits the descriptor (rejected), the
        // second echoes the capture response descriptor and succeeds.
        assert.isUndefined(restoreRequests[0]?.checkpoint);
        assert.isDefined(restoreRequests[1]?.checkpoint);
        const captureResponses = frames.filter(
          (frame) => frame.type === "response" && frame.command === "capture_checkpoint",
        );
        assert.lengthOf(captureResponses, expected.checkpointCommands);
        assert.isTrue(captureResponses[0]?.success);
        const restoreResponses = frames.filter(
          (frame) => frame.type === "response" && frame.command === "restore_checkpoint",
        );
        assert.lengthOf(restoreResponses, expected.restoreCommands);
        assert.isFalse(restoreResponses[0]?.success);
        assert.equal(restoreResponses[0]?.code, "CHECKPOINT_INVALID");
        assert.isTrue(restoreResponses[1]?.success);
        assert.equal(
          frames.filter((frame) => frame.type === "agent_settled").length,
          expected.agentSettles,
        );
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        assert.equal(projector.diagnostics().activeTasks, 0);
      }
      if (manifest.fixture.id === "pi-0.84.2-native-session-compaction-restart") {
        assert.equal(expected.status, "session-compaction-restart-complete");
        const compaction = expected.compaction;
        assert.isDefined(compaction);
        if (!compaction) throw new TypeError("Expected Pi compaction outcome metadata");
        const compactResponse = frames.find(
          (frame) => frame.type === "response" && frame.command === "compact",
        );
        assert.isDefined(compactResponse);
        assert.isTrue(compactResponse?.success);
        assert.lengthOf(
          frames.filter((frame) => frame.type === "compaction_start"),
          1,
        );
        assert.lengthOf(
          frames.filter((frame) => frame.type === "compaction_end"),
          1,
        );
        const compactionEnd = frames.find((frame) => frame.type === "compaction_end");
        assert.equal(compactionEnd?.aborted, false);
        assert.equal(compaction.compactSuccess, true);
        assert.equal(compaction.compactionStarts, 1);
        assert.equal(compaction.compactionEnds, 1);
        assert.equal(compaction.compactionEndAborted, false);
        assert.equal(compaction.hasCompactionEntry, true);
        assert.deepEqual(compaction.entryTypes, [
          "model_change",
          "thinking_level_change",
          "message",
          "message",
          "message",
          "message",
          "compaction",
        ]);
        assert.equal(compaction.restartCount, 3);
        assert.equal(compaction.restartAccepted, true);
        assert.equal(compaction.sessionIdentityPreserved, true);
        assert.lengthOf(
          frames.filter(
            (frame) => frame.type === "response" && frame.command === "negotiate_protocol",
          ),
          2,
        );
        assert.lengthOf(
          frames.filter((frame) => frame.type === "response" && frame.command === "get_state"),
          2,
        );
        assert.lengthOf(
          frames.filter((frame) => frame.type === "response" && frame.command === "prompt"),
          3,
        );
        assert.equal(frames.filter((frame) => frame.type === "agent_start").length, 3);
        assert.equal(frames.filter((frame) => frame.type === "agent_settled").length, 3);
        assert.isTrue(frames.at(-1)?.type === "agent_settled");
      }
      if (manifest.fixture.id === "omp-17.3.7-native-task-hierarchy") {
        assert.equal(expected.status, "hierarchy-complete");
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        const kinds = projected.map((event) => event.kind);
        assert.equal(
          kinds.filter((kind) => kind === "task.started").length,
          expected.canonicalSettlement?.started,
        );
        assert.equal(
          kinds.filter((kind) => kind === "task.completed").length,
          expected.canonicalSettlement?.completed,
        );
        assert.equal(
          kinds.filter((kind) => kind === "tool.started").length,
          expected.toolEvents?.started,
        );
        assert.equal(
          kinds.filter((kind) => kind === "tool.progress").length,
          expected.toolEvents?.progress,
        );
        assert.equal(
          kinds.filter((kind) => kind === "tool.completed").length,
          expected.toolEvents?.completed,
        );
        assert.equal(kinds.filter((kind) => kind === "ui.request").length, expected.uiRequests);
        assert.equal(kinds.filter((kind) => kind === "turn.started").length, expected.turnStarted);
        assert.equal(kinds.filter((kind) => kind === "turn.settled").length, expected.turnSettled);
        assert.equal(projected.at(-1)?.kind, "turn.settled");
        const subagentFrames = frames.filter((frame) => String(frame.type).startsWith("subagent_"));
        assert.equal(
          subagentFrames.filter((frame) => frame.type === "subagent_lifecycle").length,
          expected.subagentFrames?.lifecycle,
        );
        assert.equal(
          subagentFrames.filter((frame) => frame.type === "subagent_progress").length,
          expected.subagentFrames?.progress,
        );
        assert.equal(
          subagentFrames.filter((frame) => frame.type === "subagent_event").length,
          expected.subagentFrames?.event,
        );
        const snapshots = projector.snapshotTasks();
        assert.lengthOf(snapshots, 1);
        assert.equal(projector.diagnostics().activeTasks, 0);
        const child = snapshots[0];
        if (!child) throw new TypeError("Expected one durable OMP child task snapshot");
        assert.equal(child.status, "completed");
        const spawn = frames.find(
          (frame) => frame.type === "tool_execution_start" && frame.toolName === "task",
        );
        const lifecycleFrame = frames.find((frame) => frame.type === "subagent_lifecycle");
        assert.isDefined(spawn);
        assert.equal(child.parentToolCallId, spawn.toolCallId);
        if (typeof lifecycleFrame?.payload !== "object" || lifecycleFrame?.payload === null)
          throw new TypeError("Expected subagent lifecycle payload record");
        const lifecyclePayload = lifecycleFrame.payload as { readonly id?: unknown };
        assert.equal(child.id, lifecyclePayload.id);
        assert.equal(child.role, "sonic");
        assert.equal(child.runHandles?.sessionFile, "[normalized:path:01]");
        assert.equal(child.usage?.toolCalls, 1);
        assert.isTrue(String(child.id).startsWith("[normalized:id:"));
      }
      if (manifest.fixture.id === "pi-0.84.2-native-semantic-host-tasks") {
        assert.equal(expected.status, "semantic-host-tasks-complete");
        assert.deepEqual(
          frames
            .filter((frame) => String(frame.type).startsWith("host_task_"))
            .map((frame) => frame.type),
          expected.hostFrames,
        );
        assert.deepEqual(
          frames
            .filter(
              (frame) =>
                String(frame.type).startsWith("host_task_") &&
                typeof frame.task === "object" &&
                frame.task !== null &&
                !Array.isArray(frame.task) &&
                (frame.task as { readonly kind?: unknown }).kind === "job",
            )
            .map((frame) => (frame.task as { readonly status?: unknown }).status),
          expected.childStatuses,
        );
        assert.deepEqual(
          frames
            .filter(
              (frame) =>
                String(frame.type).startsWith("host_task_") &&
                typeof frame.task === "object" &&
                frame.task !== null &&
                !Array.isArray(frame.task) &&
                (frame.task as { readonly kind?: unknown }).kind === "workflow",
            )
            .map((frame) => (frame.task as { readonly status?: unknown }).status),
          expected.parentStatuses,
        );
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        assert.deepEqual(
          projected.map((event) => event.kind),
          expected.projectedKinds,
        );
        assert.equal(projector.diagnostics().activeTasks, 0);
        assert.equal(expected.hasToolFrames, false);
        const snapshots = projector.snapshotTasks();
        assert.lengthOf(snapshots, 2);
        const parent = snapshots.find((task) => task.kind === "workflow");
        const child = snapshots.find((task) => task.kind === "job");
        assert.isDefined(parent);
        assert.isDefined(child);
        assert.equal(parent?.status, "completed");
        assert.equal(child?.status, "completed");
        assert.isUndefined(parent?.parentToolCallId);
        assert.isDefined(child?.parentToolCallId);
        assert.isTrue(String(child?.parentToolCallId).startsWith("[normalized:toolcall:"));
      }
      if (manifest.fixture.id === "pi-0.84.2-native-portable-extension-ui") {
        assert.equal(expected.status, "portable-extension-ui-complete");
        assert.deepEqual(
          frames
            .filter((frame) => frame.type === "extension_ui_request")
            .map((frame) => frame.method),
          expected.uiMethods,
        );
        const stdinFrames = fixture.capture.chunks
          .filter((chunk) => chunk.stream === "stdin")
          .flatMap((chunk) =>
            Buffer.from(chunk.bytesBase64, "base64")
              .toString("utf8")
              .split("\\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line) as Record<string, unknown>),
          );
        assert.deepEqual(
          stdinFrames
            .filter((frame) => frame.type === "extension_ui_response")
            .map((frame) =>
              "confirmed" in frame
                ? "confirmed"
                : "cancelled" in frame
                  ? "cancelled"
                  : "value" in frame
                    ? "value"
                    : "other",
            ),
          expected.responseKinds,
        );
        assert.include(expected.capabilityFallbacks, "arbitraryTerminalComponents:false");
        assert.include(expected.capabilityFallbacks, "terminalInput:unsupported");
        assert.include(expected.capabilityFallbacks, "custom:unsupported");
        assert.equal(expected.customUiFrame, false);
        assert.equal(expected.factoryUiFrames, false);
        assert.equal(
          frames.some(
            (frame) =>
              frame.type === "extension_ui_request" &&
              [
                "custom",
                "onTerminalInput",
                "setFooter",
                "setHeader",
                "setEditorComponent",
              ].includes(String(frame.method)),
          ),
          false,
        );
        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        assert.deepEqual(
          projected.map((event) => event.kind),
          expected.projectedKinds,
        );
        assert.equal(projector.diagnostics().activeTasks, 0);
      }
      if (manifest.fixture.id.endsWith("-native-root")) {
        assert.isDefined(expected.eventTypes);
        assert.isDefined(expected.adapterEventTypes);
        assert.include(expected.adapterEventTypes, "turn.started");
        assert.equal(expected.adapterEventTypes.at(-1), "turn.completed");
        assert.equal(expected.status, expected.adapterEventTypes.at(-1));
        assert.equal(
          expected.outputMarker,
          reviewed.runtime === "pi" ? "PI-NATIVE-ROOT-OK" : "OMP-BROKER-ROOT-OK",
        );
        assert.equal(
          expected.teardownObservation,
          "terminal process receipt follows authoritative turn.completed",
        );

        const projector = new PiFamilyEventProjector(reviewed.runtime);
        const projected = frames.flatMap((frame) => projector.project(frame));
        assert.deepEqual(
          projected.map((event) => event.kind),
          expected.eventTypes,
        );
        const lifecycle = projected
          .map((event) => event.kind)
          .filter((kind) => kind === "turn.started" || kind === "turn.settled");
        assert.deepEqual(lifecycle, expected.canonicalLifecycle);
        assert.isAbove(lifecycle.filter((kind) => kind === "turn.started").length, 0);
        assert.deepEqual(
          lifecycle.filter((kind) => kind === "turn.settled"),
          ["turn.settled"],
        );
        const terminal = projected.at(-1);
        assert.equal(terminal?.kind, "turn.settled");
        if (terminal?.kind === "turn.settled") {
          assert.equal(
            terminal.raw.type,
            reviewed.runtime === "pi" ? "agent_settled" : "agent_end",
          );
          if (reviewed.runtime === "omp") assert.equal(terminal.raw.isTerminal, true);
        }
      }

      const normalized = normalizeNativeTrace(frames);
      assert.deepEqual(normalizeNativeTrace(normalized), normalized);
    }
  });
  it("projects direct Pi/OMP wire parsing identically to production replay", () => {
    // The direct path parses each captured stdout line as the native process
    // emits it. The replay path uses the production StrictJsonlDecoder and,
    // for OMP, the production chunk assembler. Both paths must yield the same
    // canonical events and durable task/UI/unknown state.
    for (const fixture of fixtures) {
      const fixtureId = fixture.manifest?.fixture.id;
      const reviewed = reviewedProvenance[fixtureId ?? ""];
      assert.isDefined(reviewed);
      const runtime = fixture.manifest?.runtime.kind;
      assert.isDefined(runtime);
      const directAssembler = runtime === "omp" ? new OmpChunkAssembler() : undefined;
      const directFrames = fixture.capture.chunks
        .filter((chunk) => chunk.stream === "stdout")
        .sort((left, right) => left.sequence - right.sequence)
        .flatMap((chunk) =>
          Buffer.from(chunk.bytesBase64, "base64")
            .toString("utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const parsed = JSON.parse(line) as RpcEnvelope;
              return directAssembler ? directAssembler.accept(parsed) : parsed;
            })
            .filter((frame): frame is RpcEnvelope => frame !== undefined),
        );
      assert.equal(directAssembler?.pendingMessageCount ?? 0, 0);
      const replayedFrames = replayStdout(fixture);
      assert.deepEqual(directFrames, replayedFrames);
      const directProjector = new PiFamilyEventProjector(runtime);
      const replayProjector = new PiFamilyEventProjector(runtime);
      assert.deepEqual(
        directFrames.flatMap((frame) => directProjector.project(frame)),
        replayedFrames.flatMap((frame) => replayProjector.project(frame)),
      );
      assert.deepEqual(directProjector.snapshotTasks(), replayProjector.snapshotTasks());
      assert.deepEqual(
        directProjector.snapshotUnknownEvents(),
        replayProjector.snapshotUnknownEvents(),
      );
      assert.deepEqual(directProjector.diagnostics(), replayProjector.diagnostics());
      assert.deepEqual(fixture.capture.exits, [
        {
          sequence: fixture.capture.totalEvents - 1,
          code: reviewed.exitCode,
          signal: null,
        },
      ]);
    }
  });
});
