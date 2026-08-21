import * as NodeBuffer from "node:buffer";
import { assert, describe, it } from "vite-plus/test";

import ompFixture from "./testFixtures/native/omp-17.3.7.json" with { type: "json" };
import piFixture from "./testFixtures/native/pi-0.84.2.json" with { type: "json" };
import {
  normalizeNativeTrace,
  validateNativeTraceCorpus,
  type NativeTraceCaptureEnvelope,
} from "./NativeTrace.ts";

const fixtures = validateNativeTraceCorpus([piFixture, ompFixture]);

function replayStdout(fixture: NativeTraceCaptureEnvelope): ReadonlyArray<Record<string, unknown>> {
  return fixture.capture.chunks
    .filter((chunk) => chunk.stream === "stdout")
    .flatMap((chunk) =>
      NodeBuffer.Buffer.from(chunk.bytesBase64, "base64")
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

describe("checked-in native trace corpus", () => {
  it("accepts only reviewed, exact-binary Pi and OMP captures", () => {
    assert.deepEqual(
      fixtures.map((fixture) => fixture.manifest?.runtime.kind),
      ["pi", "omp"],
    );

    for (const fixture of fixtures) {
      const manifest = fixture.manifest;
      assert.isDefined(manifest);
      assert.isFalse(manifest.fixture.synthetic);
      assert.equal(manifest.runtime.revision, `binary-sha256:${manifest.provenance.sourceSha256}`);
      assert.isTrue(manifest.redaction.reviewed);
      assert.isTrue(manifest.redaction.leakScanPassed);
      assert.deepEqual(manifest.redaction.unknownPaths, []);
      assert.isFalse(fixture.capture.truncated);
    }
  });

  it("replays exact sanitized frames to the recorded normalized outcomes", () => {
    for (const fixture of fixtures) {
      const manifest = fixture.manifest;
      assert.isDefined(manifest);
      const frames = replayStdout(fixture);
      const expected = manifest.expectedOutcome.value as {
        readonly frameTypes: ReadonlyArray<string>;
        readonly responseCommands: ReadonlyArray<string>;
      };
      assert.deepEqual(
        frames.map((frame) => frame.type),
        [...expected.frameTypes],
      );
      assert.deepEqual(
        frames.filter((frame) => frame.type === "response").map((frame) => frame.command),
        [...expected.responseCommands],
      );

      const normalized = normalizeNativeTrace(frames);
      assert.deepEqual(normalizeNativeTrace(normalized), normalized);
    }
  });
});
