import type { ProviderDriverKind } from "@t3tools/contracts";

import type {
  HttpTransferMeasurement,
  WebSocketTransferTotals,
} from "./NetworkTransferMeasurement.integration.ts";
import {
  TRANSFER_HISTORY_MCP_RESULT_BYTES,
  TRANSFER_HISTORY_TOOLS_PER_TURN,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_MEASURED_MCP_RESULT_BYTES,
  TRANSFER_MEASURED_TOOLS,
} from "./fixtures/transferBudget.ts";

export interface TransferBudgetRun {
  readonly provider: ProviderDriverKind;
  /** Cold HTTP bootstrap measurement. */
  readonly threadSnapshot: HttpTransferMeasurement;
  /** Second HTTP bootstrap from a resumed client. */
  readonly resumedThreadSnapshot: HttpTransferMeasurement;
  readonly measuredTurnWebSocket: WebSocketTransferTotals;
  /** Number of concurrent subscribers receiving the measured turn. */
  readonly fanoutClients: number;
}

interface ProviderTransferBudget {
  readonly totalWireBytes: number;
  readonly threadSnapshotWireBytes: number;
  readonly resumedThreadSnapshotWireBytes: number;
  readonly measuredTurnWebSocketWireBytes: number;
  readonly measuredTurnWebSocketDecodedBytes: number;
  readonly measuredTurnWebSocketMessages: number;
  readonly measuredTurnWebSocketLargestMessageBytes: number;
  readonly fanoutClients: number;
}

// Ceilings retain measured headroom while staying provider-specific. Pi's
// compact native payload is lower; OMP's task metadata gets a slightly wider
// HTTP allowance. The report preserves the measured baseline for review.
export const TRANSFER_BUDGETS: Readonly<Record<string, ProviderTransferBudget>> = {
  codex: {
    totalWireBytes: 23_000,
    threadSnapshotWireBytes: 7_500,
    resumedThreadSnapshotWireBytes: 7_500,
    measuredTurnWebSocketWireBytes: 8_000,
    measuredTurnWebSocketDecodedBytes: 68_000,
    measuredTurnWebSocketMessages: 21,
    measuredTurnWebSocketLargestMessageBytes: 12_000,
    fanoutClients: 2,
  },
  claudeAgent: {
    totalWireBytes: 23_100,
    threadSnapshotWireBytes: 7_550,
    resumedThreadSnapshotWireBytes: 7_550,
    measuredTurnWebSocketWireBytes: 8_050,
    measuredTurnWebSocketDecodedBytes: 69_000,
    measuredTurnWebSocketMessages: 21,
    measuredTurnWebSocketLargestMessageBytes: 12_000,
    fanoutClients: 2,
  },
  pi: {
    totalWireBytes: 22_900,
    threadSnapshotWireBytes: 7_450,
    resumedThreadSnapshotWireBytes: 7_450,
    measuredTurnWebSocketWireBytes: 7_950,
    measuredTurnWebSocketDecodedBytes: 67_000,
    measuredTurnWebSocketMessages: 20,
    measuredTurnWebSocketLargestMessageBytes: 12_000,
    fanoutClients: 2,
  },
  omp: {
    totalWireBytes: 23_200,
    threadSnapshotWireBytes: 7_600,
    resumedThreadSnapshotWireBytes: 7_600,
    measuredTurnWebSocketWireBytes: 8_050,
    measuredTurnWebSocketDecodedBytes: 68_000,
    measuredTurnWebSocketMessages: 21,
    measuredTurnWebSocketLargestMessageBytes: 12_000,
    fanoutClients: 2,
  },
};

function totalWireBytes(run: TransferBudgetRun): number {
  return (
    run.threadSnapshot.wireBytes +
    run.resumedThreadSnapshot.wireBytes +
    run.measuredTurnWebSocket.wireBytes
  );
}

function observedTransfer(run: TransferBudgetRun) {
  return {
    totalWireBytes: totalWireBytes(run),
    threadSnapshotWireBytes: run.threadSnapshot.wireBytes,
    threadSnapshotDecodedBytes: run.threadSnapshot.decodedBodyBytes,
    resumedThreadSnapshotWireBytes: run.resumedThreadSnapshot.wireBytes,
    resumedThreadSnapshotDecodedBytes: run.resumedThreadSnapshot.decodedBodyBytes,
    measuredTurnWebSocketWireBytes: run.measuredTurnWebSocket.wireBytes,
    measuredTurnWebSocketDecodedBytes: run.measuredTurnWebSocket.decodedBytes,
    measuredTurnWebSocketMessages: run.measuredTurnWebSocket.messages,
    measuredTurnWebSocketLargestMessageBytes: run.measuredTurnWebSocket.largestMessageBytes,
    fanoutClients: run.fanoutClients,
  };
}

/** Machine-readable input for the trusted PR comment publisher. */
export function formatTransferBudgetResult(runs: ReadonlyArray<TransferBudgetRun>): string {
  const providers = Object.fromEntries(
    runs.flatMap((run) => {
      const ceiling = TRANSFER_BUDGETS[run.provider];
      return ceiling ? [[run.provider, { observed: observedTransfer(run), ceiling }]] : [];
    }),
  );

  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scenario: {
        id: "thread-transfer-v1",
        historyTurns: TRANSFER_HISTORY_TURN_COUNT,
        historyCommandToolsPerTurn: TRANSFER_HISTORY_TOOLS_PER_TURN,
        historyMcpResultBytes: TRANSFER_HISTORY_MCP_RESULT_BYTES,
        measuredCommandTools: TRANSFER_MEASURED_TOOLS,
        measuredMcpResultBytes: TRANSFER_MEASURED_MCP_RESULT_BYTES,
      },
      providers,
    },
    null,
    2,
  )}\n`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes >= 1_024 * 1_024) {
    return `${(bytes / 1_024 / 1_024).toFixed(2)} MiB (${bytes.toLocaleString("en-US")} B)`;
  }
  return `${(bytes / 1_024).toFixed(1)} KiB (${bytes.toLocaleString("en-US")} B)`;
}

function row(
  provider: ProviderDriverKind,
  phase: string,
  metric: string,
  observed: number,
  maximum: number,
  format: (value: number) => string = formatBytes,
): string {
  const status = observed <= maximum ? "PASS" : "FAIL";
  return `| ${provider} | ${phase} | ${metric} | ${format(observed)} | ${format(maximum)} | ${status} |`;
}

export function transferBudgetViolations(runs: ReadonlyArray<TransferBudgetRun>): string[] {
  const violations: string[] = [];
  for (const run of runs) {
    const budget = TRANSFER_BUDGETS[run.provider];
    if (!budget) {
      violations.push(`${run.provider}: no transfer budget is configured`);
      continue;
    }
    const checks = [
      ["total thread wire bytes", totalWireBytes(run), budget.totalWireBytes],
      ["thread snapshot wire bytes", run.threadSnapshot.wireBytes, budget.threadSnapshotWireBytes],
      [
        "resumed thread snapshot wire bytes",
        run.resumedThreadSnapshot.wireBytes,
        budget.resumedThreadSnapshotWireBytes,
      ],
      [
        "measured-turn WebSocket wire bytes",
        run.measuredTurnWebSocket.wireBytes,
        budget.measuredTurnWebSocketWireBytes,
      ],
      [
        "measured-turn WebSocket decoded bytes",
        run.measuredTurnWebSocket.decodedBytes,
        budget.measuredTurnWebSocketDecodedBytes,
      ],
      [
        "measured-turn WebSocket messages",
        run.measuredTurnWebSocket.messages,
        budget.measuredTurnWebSocketMessages,
      ],
      [
        "measured-turn largest WebSocket message bytes",
        run.measuredTurnWebSocket.largestMessageBytes,
        budget.measuredTurnWebSocketLargestMessageBytes,
      ],
      ["fanout clients", run.fanoutClients, budget.fanoutClients],
    ] as const;
    for (const [metric, observed, maximum] of checks) {
      if (observed > maximum) {
        violations.push(`${run.provider}: ${metric} was ${observed}, maximum ${maximum}`);
      }
    }
  }
  return violations;
}

export function formatTransferBudgetReport(runs: ReadonlyArray<TransferBudgetRun>): string {
  const lines = [
    "# T3 Code thread transfer budget",
    "",
    "Wire values are thread data bytes read from local HTTP and WebSocket sockets. HTTP includes response headers; WebSocket measurement starts after the resumed thread subscription synchronizes. TCP/IP, TLS framing, and the WebSocket upgrade are excluded. WebSocket permessage-deflate is negotiated.",
    `Scenario: ${TRANSFER_HISTORY_TURN_COUNT} historical turns with ${TRANSFER_HISTORY_TOOLS_PER_TURN} command tools and one retained ${formatBytes(TRANSFER_HISTORY_MCP_RESULT_BYTES)} MCP result each, followed by one measured turn with ${TRANSFER_MEASURED_TOOLS} command tools and a retained ${formatBytes(TRANSFER_MEASURED_MCP_RESULT_BYTES)} MCP result. Payload sizes use deterministic, privacy-safe synthetic fixtures covering the Codex, Claude Agent, Pi, and OMP (Oh My Pi) provider families; no raw private traces or user data are committed.`,
    "",
    "| Provider | Total thread wire | Budget | Result |",
    "| --- | ---: | ---: | --- |",
    ...runs.flatMap((run) => {
      const budget = TRANSFER_BUDGETS[run.provider];
      if (!budget) return [];
      const observed = observedTransfer(run).totalWireBytes;
      return [
        `| ${run.provider} | ${formatBytes(observed)} | ${formatBytes(budget.totalWireBytes)} | ${observed <= budget.totalWireBytes ? "PASS" : "FAIL"} |`,
      ];
    }),
    "",
    "## Detailed measurements",
    "",
    "| Provider | Phase | Metric | Observed | Budget | Result |",
    "| --- | --- | --- | ---: | ---: | --- |",
  ];

  for (const run of runs) {
    const budget = TRANSFER_BUDGETS[run.provider];
    if (!budget) continue;
    lines.push(
      row(
        run.provider,
        "cold snapshot",
        "HTTP wire",
        run.threadSnapshot.wireBytes,
        budget.threadSnapshotWireBytes,
      ),
      row(
        run.provider,
        "resumed snapshot",
        "HTTP wire",
        run.resumedThreadSnapshot.wireBytes,
        budget.resumedThreadSnapshotWireBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket wire",
        run.measuredTurnWebSocket.wireBytes,
        budget.measuredTurnWebSocketWireBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket decoded",
        run.measuredTurnWebSocket.decodedBytes,
        budget.measuredTurnWebSocketDecodedBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket largest message",
        run.measuredTurnWebSocket.largestMessageBytes,
        budget.measuredTurnWebSocketLargestMessageBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket messages",
        run.measuredTurnWebSocket.messages,
        budget.measuredTurnWebSocketMessages,
        String,
      ),
      row(
        run.provider,
        "measured turn",
        "fanout clients",
        run.fanoutClients,
        budget.fanoutClients,
        String,
      ),
    );
  }

  lines.push("", "## Compression diagnostics", "");
  for (const run of runs) {
    lines.push(
      `- ${run.provider}: cold snapshot ${formatBytes(run.threadSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.threadSnapshot.encodedBodyBytes)} gzip; resumed snapshot ${formatBytes(run.resumedThreadSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.resumedThreadSnapshot.encodedBodyBytes)} gzip.`,
    );
  }

  return `${lines.join("\n")}\n`;
}
