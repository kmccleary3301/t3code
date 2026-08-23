import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import type {
  HttpTransferMeasurement,
  WebSocketTransferTotals,
} from "./NetworkTransferMeasurement.integration.ts";
import {
  transferBudgetViolations,
  type TransferBudgetRun,
} from "./TransferBudgetReport.integration.ts";

const httpMeasurement = (wireBytes: number): HttpTransferMeasurement => ({
  status: 200,
  contentEncoding: "gzip",
  encodedBody: new Uint8Array(wireBytes),
  encodedBodyBytes: wireBytes,
  decodedBody: new Uint8Array(112_000),
  decodedBodyBytes: 112_000,
  wireBytes,
});

const webSocketMeasurement = (
  overrides?: Partial<WebSocketTransferTotals>,
): WebSocketTransferTotals => ({
  wireBytes: 6_900,
  decodedBytes: 57_000,
  messages: 20,
  largestMessageBytes: 6_500,
  ...overrides,
});

const run = (overrides?: Partial<TransferBudgetRun>): TransferBudgetRun => ({
  provider: ProviderDriverKind.make("codex"),
  threadSnapshot: httpMeasurement(7_100),
  resumedThreadSnapshot: httpMeasurement(7_100),
  measuredTurnWebSocket: webSocketMeasurement(),
  fanoutClients: 2,
  ...overrides,
});

it("fails when a resumed bootstrap exceeds its provider ceiling", () => {
  assert.deepEqual(transferBudgetViolations([run()]), []);
  assert.deepEqual(
    transferBudgetViolations([run({ resumedThreadSnapshot: httpMeasurement(7_501) })]),
    ["codex: resumed thread snapshot wire bytes was 7501, maximum 7500"],
  );
});

it("fails when a fanout or largest-message ceiling regresses", () => {
  assert.deepEqual(
    transferBudgetViolations([
      run({
        measuredTurnWebSocket: webSocketMeasurement({ largestMessageBytes: 12_001 }),
        fanoutClients: 3,
      }),
    ]),
    [
      "codex: measured-turn largest WebSocket message bytes was 12001, maximum 12000",
      "codex: fanout clients was 3, maximum 2",
    ],
  );
});
