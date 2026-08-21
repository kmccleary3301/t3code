import * as NodeBuffer from "node:buffer";
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
import { OmpChunkAssembler } from "./OmpChunkAssembler.ts";
import { parseJsonObject, type RpcEnvelope } from "./protocol.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";

const committedFixtures = [piFixture, ompFixture, piRootFixture, ompRootFixture] as const;
const fixtures = validateNativeTraceCorpus(committedFixtures);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const MAX_COMMITTED_FIXTURE_BYTES = 1024 * 1024;
const reviewedProvenance: Readonly<
  Record<
    string,
    {
      readonly runtime: "pi" | "omp";
      readonly version: string;
      readonly revision: string;
      readonly sourceSha256: string;
    }
  >
> = {
  "pi-0.84.2-native-handshake": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:bffdb3b169c487e8c6dee9db0f92ae0fdac7c995e76f8865cea26f9f1ed2c4ed",
    sourceSha256: "bffdb3b169c487e8c6dee9db0f92ae0fdac7c995e76f8865cea26f9f1ed2c4ed",
  },
  "omp-17.3.7-native-handshake": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c7609f9b16802fdc01d40ebd184e1efb86067e89bafb770430c8ddf6dca074c0",
    sourceSha256: "c7609f9b16802fdc01d40ebd184e1efb86067e89bafb770430c8ddf6dca074c0",
  },
  "pi-0.84.2-native-root": {
    runtime: "pi",
    version: "0.84.2",
    revision: "binary-sha256:840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521",
    sourceSha256: "59578880c56c556236508f3b3a63b7269addb9cf867c0dd9f31e22d6bf6e3f50",
  },
  "omp-17.3.7-native-root": {
    runtime: "omp",
    version: "17.3.7",
    revision: "binary-sha256:c1434d85392024aab964220b3c3fd27afe1241d13d5488dac84b489d1f052b0d",
    sourceSha256: "8821372065d89a7a4750e10b38bd60691b1e3e37fb5fb49857f971936e0c3408",
  },
};

function replayStdout(fixture: NativeTraceCaptureEnvelope): ReadonlyArray<RpcEnvelope> {
  const decoder = new StrictJsonlDecoder(1_048_576);
  const assembler = fixture.manifest?.runtime.kind === "omp" ? new OmpChunkAssembler() : undefined;
  const frames: RpcEnvelope[] = [];
  const consume = (line: string): void => {
    const frame = parseJsonObject(line);
    const assembled = assembler?.accept(frame) ?? frame;
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
    for (const fixture of committedFixtures) {
      assert.isAtMost(
        new TextEncoder().encode(encodeUnknownJson(fixture)).byteLength,
        MAX_COMMITTED_FIXTURE_BYTES,
      );
    }
  });

  it("accepts only reviewed, exact-binary Pi and OMP captures", () => {
    assert.deepEqual(
      fixtures.map((fixture) => fixture.manifest?.runtime.kind),
      ["pi", "omp", "pi", "omp"],
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
      assert.equal(expected.exit.code, 143);
      assert.isNull(expected.exit.signal);
      const serializedFrames = JSON.stringify(frames);
      assert.notInclude(serializedFrames, "pocock-");
      assert.notInclude(serializedFrames, "/Users/");
      for (const frame of frames.filter((frame) => frame.type === "available_commands_update")) {
        assert.deepEqual(frame.commands, []);
      }
      if (expected.responseCommands !== undefined) {
        assert.deepEqual(
          frames.filter((frame) => frame.type === "response").map((frame) => frame.command),
          [...expected.responseCommands],
        );
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
});
