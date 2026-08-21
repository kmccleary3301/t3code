import * as NodeBuffer from "node:buffer";
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
import { OmpChunkAssembler } from "./OmpChunkAssembler.ts";
import { parseJsonObject } from "./protocol.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";

const fixtures = validateNativeTraceCorpus([piFixture, ompFixture, piRootFixture, ompRootFixture]);

function replayStdout(fixture: NativeTraceCaptureEnvelope): ReadonlyArray<Record<string, unknown>> {
  const decoder = new StrictJsonlDecoder(1_048_576);
  const assembler = fixture.manifest?.runtime.kind === "omp" ? new OmpChunkAssembler() : undefined;
  const frames: Record<string, unknown>[] = [];
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
  it("accepts only reviewed, exact-binary Pi and OMP captures", () => {
    assert.deepEqual(
      fixtures.map((fixture) => fixture.manifest?.runtime.kind),
      ["pi", "omp", "pi", "omp"],
    );

    for (const fixture of fixtures) {
      const manifest = fixture.manifest;
      assert.isDefined(manifest);
      assert.isFalse(manifest.fixture.synthetic);
      assert.match(manifest.runtime.revision, /^binary-sha256:[0-9a-f]{64}$/u);
      const sourceSha256 = manifest.provenance.sourceSha256;
      assert.isTrue(typeof sourceSha256 === "string");
      assert.match(typeof sourceSha256 === "string" ? sourceSha256 : "", /^[0-9a-f]{64}$/u);
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
      const frames = replayStdout(fixture);
      const expected = manifest.expectedOutcome.value as {
        readonly frameTypes?: ReadonlyArray<string>;
        readonly rawFrameTypes?: ReadonlyArray<string>;
        readonly responseCommands?: ReadonlyArray<string>;
        readonly status?: string;
        readonly outputMarker?: string;
      };
      assert.deepEqual(
        frames.map((frame) => frame.type),
        [...(expected.rawFrameTypes ?? expected.frameTypes ?? [])],
      );
      if (expected.responseCommands !== undefined) {
        assert.deepEqual(
          frames.filter((frame) => frame.type === "response").map((frame) => frame.command),
          [...expected.responseCommands],
        );
      }
      if (manifest.fixture.id.endsWith("-native-root")) {
        assert.equal(expected.status, "turn.completed");
        assert.equal(
          expected.outputMarker,
          manifest.runtime.kind === "pi" ? "PI-NATIVE-ROOT-OK" : "OMP-BROKER-ROOT-OK",
        );
      }

      const normalized = normalizeNativeTrace(frames);
      assert.deepEqual(normalizeNativeTrace(normalized), normalized);
    }
  });
});
