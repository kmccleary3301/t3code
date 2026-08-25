import type { JsonRecord, PiFamilyRuntimeKind } from "../src/provider/piFamily/protocol.ts";
import {
  ompRecordedNativeTrace,
  piRecordedNativeTrace,
} from "../src/provider/piFamily/nativeTraceFixtures.ts";

/**
 * Launch arguments for the production Pi-family adapter's native-process path.
 *
 * The child is a deterministic playback of the reviewed, structurally scrubbed
 * native capture. It still speaks the wire dialect expected by the adapter:
 * Pi emits JSONL envelopes and OMP emits a plain ready/response envelope plus
 * chunked JSONL event envelopes. No T3 orchestration code is bypassed.
 */
export function nativeReplayLaunchArguments(
  runtime: PiFamilyRuntimeKind,
  traceOverride?: readonly JsonRecord[],
): readonly string[] {
  if (runtime !== "pi" && runtime !== "omp") {
    throw new Error(`Unsupported native replay runtime: ${runtime}`);
  }

  const trace =
    traceOverride ?? (runtime === "pi" ? piRecordedNativeTrace : ompRecordedNativeTrace);
  const capabilities = {
    runtime,
    runtimeVersion: "replay-capture",
    protocolVersion: runtime === "omp" ? 2 : 1,
    supportedProtocolVersions: runtime === "omp" ? [1, 2] : [1],
    ...(runtime === "omp"
      ? {
          negotiatedProtocolVersion: 2,
          transport: {
            strictLfJsonl: true,
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
            chunking: true,
          },
        }
      : {
          transport: { strictLfJsonl: true, chunking: false },
        }),
    models: { discover: true, switch: true },
    thinking: { discover: true, switch: true },
    commands: { discover: true, invokeNative: true },
    sessions: {
      resume: true,
      tree: true,
      fork: true,
      compact: true,
      nativeCheckpoint: runtime === "pi",
      completeTurnRollback: false,
    },
    ui: {
      select: true,
      confirm: true,
      input: true,
      editor: true,
      notify: true,
      status: true,
      widget: true,
      openUrl: false,
      arbitraryTerminalComponents: false,
    },
    tasks: {
      lifecycle: true,
      nested: runtime === "omp",
      childTranscript: false,
      workflows: runtime === "omp",
      background: runtime === "omp",
      targetedCancellation: false,
    },
  } as const;

  const script = [
    'const readline = require("node:readline");',
    `const runtime = ${JSON.stringify(runtime)};`,
    `const trace = ${JSON.stringify(trace satisfies readonly JsonRecord[])};`,
    `const capabilities = ${JSON.stringify(capabilities)};`,
    'const out = value => process.stdout.write(JSON.stringify(value) + "\\n");',
    "const chunk = (value, index) => {",
    "  const bytes = Buffer.from(JSON.stringify(value));",
    "  const split = Math.ceil(bytes.length / 2);",
    "  for (const chunkIndex of [0, 1]) {",
    "    const part = bytes.subarray(chunkIndex === 0 ? 0 : split, chunkIndex === 0 ? split : undefined);",
    '    out({ type: "rpc_chunk", chunkId: `replay-${index}`, index: chunkIndex, count: 2, byteLength: bytes.length, data: part.toString("base64") });',
    "  }",
    "};",
    'const emitNative = (value, index) => runtime === "omp" ? chunk(value, index) : out(value);',
    'if (runtime === "omp") out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });',
    "const rl = readline.createInterface({ input: process.stdin });",
    'rl.on("line", line => {',
    "  const command = JSON.parse(line);",
    '  if (command.type === "negotiate_protocol") { out({ id: command.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }); return; }',
    '  if (command.type === "get_capabilities") { out({ id: command.id, type: "response", command: "get_capabilities", success: true, data: capabilities }); return; }',
    '  if (command.type === "set_subagent_subscription") { out({ id: command.id, type: "response", command: "set_subagent_subscription", success: true }); return; }',
    '  if (command.type === "set_model") { out({ id: command.id, type: "response", command: "set_model", success: true }); return; }',
    '  if (command.type === "prompt") {',
    '    out({ id: command.id, type: "response", command: "prompt", success: true });',
    "    trace.forEach((value, index) => {",
    "      const next = { ...value };",
    '      if (next.type === "prompt_result") next.id = command.id;',
    "      emitNative(next, index);",
    "    });",
    "    return;",
    "  }",
    '  if (command.type === "abort") { out({ id: command.id, type: "response", command: "abort", success: true }); return; }',
    '  if (command.type === "capture_checkpoint" || command.type === "checkpoint") { const data = runtime === "omp" ? { runtime, sessionId: "replay-session", checkpointId: "replay-leaf" } : { runtime, sessionId: "replay-session", leafEntryId: "replay-leaf" }; out({ id: command.id, type: "response", command: command.type, success: true, data }); return; }',
    '  if (command.type === "restore_checkpoint" || command.type === "rewind") { out({ id: command.id, type: "response", command: command.type, success: true, data: { rewound: true } }); return; }',
    "});",
  ].join("\n");

  return ["-e", script, "--"];
}
