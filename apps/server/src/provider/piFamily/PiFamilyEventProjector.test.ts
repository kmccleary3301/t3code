import { assert, describe, it } from "vite-plus/test";

import { PiFamilyEventProjector, nativeEventId } from "./PiFamilyEventProjector.ts";

describe("Pi/OMP native event projection", () => {
  it("settles Pi only after agent_settled and keeps IDs restart-stable", () => {
    const pi = new PiFamilyEventProjector("pi");
    pi.project({
      type: "prompt_result",
      id: "turn-1",
      accepted: true,
      agentInvoked: true,
      outcome: "started",
    });
    assert.deepEqual(pi.project({ type: "agent_start" }), [
      { kind: "turn.started", requestId: "turn-1", raw: { type: "agent_start" } },
    ]);
    assert.deepEqual(pi.project({ type: "turn_end" }), []);
    assert.deepEqual(pi.project({ type: "agent_end", willRetry: false }), []);
    const event = { type: "agent_settled" };
    assert.deepEqual(pi.project(event), [
      { kind: "turn.settled", requestId: "turn-1", raw: event },
    ]);
    assert.equal(nativeEventId("pi", event), nativeEventId("pi", structuredClone(event)));
    assert.notEqual(nativeEventId("pi", event), nativeEventId("omp", event));
    const repeated = { type: "message_update", delta: { text: "same" } };
    assert.equal(
      nativeEventId("pi", repeated, 0),
      nativeEventId("pi", structuredClone(repeated), 0),
    );
    assert.notEqual(nativeEventId("pi", repeated, 0), nativeEventId("pi", repeated, 1));
    const oversized = {
      type: `future_${"t".repeat(20_000)}`,
      id: "i".repeat(20_000),
    };
    const oversizedIdentity = nativeEventId("pi", oversized);
    assert.isAtMost(oversizedIdentity.length, 256);
    assert.equal(oversizedIdentity, nativeEventId("pi", structuredClone(oversized)));
  });
  it("settles OMP turns on terminal assistant messages and suppresses a later duplicate end", () => {
    const projector = new PiFamilyEventProjector("omp");
    projector.project({ type: "agent_start", requestId: "turn-1" });
    const update = projector.project({
      type: "message_update",
      delta: { text: "final" },
    });
    const messageEnd = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason: "stop",
      },
    };
    const final = projector.project(messageEnd);
    assert.deepEqual(
      update.map((event) => event.kind),
      ["message.delta"],
    );
    assert.deepEqual(
      final.map((event) => event.kind),
      ["message.completed", "turn.settled"],
    );
    assert.deepEqual(final[1], {
      kind: "turn.settled",
      requestId: "turn-1",
      raw: messageEnd,
    });
    assert.deepEqual(
      projector.project({
        type: "agent_end",
        requestId: "turn-1",
        isTerminal: true,
      }),
      [],
    );
  });

  it("does not settle OMP turns on intermediate tool-call messages", () => {
    const projector = new PiFamilyEventProjector("omp");
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "task" }],
        stopReason: "toolUse",
      },
    };
    assert.deepEqual(projector.project(event), [{ kind: "runtime.raw", event }]);
  });

  it("ignores OMP model-segment turn markers inside one agent run", () => {
    const projector = new PiFamilyEventProjector("omp");
    assert.equal(projector.project({ type: "agent_start" })[0]?.kind, "turn.started");
    assert.deepEqual(projector.project({ type: "turn_start" }), []);
    assert.deepEqual(projector.project({ type: "turn_end" }), []);
  });

  it("does not settle turns on accepted prompts that start or queue agent work", () => {
    const projector = new PiFamilyEventProjector("pi");
    const started = {
      type: "prompt_result",
      id: "turn-started",
      accepted: true,
      agentInvoked: true,
      outcome: "started",
    };
    const queued = {
      type: "prompt_result",
      id: "turn-queued",
      accepted: true,
      agentInvoked: true,
      outcome: "queued",
    };
    const handled = {
      type: "prompt_result",
      id: "turn-handled",
      accepted: true,
      agentInvoked: false,
      outcome: "handled",
    };

    assert.equal(projector.project(started)[0]?.kind, "runtime.raw");
    assert.equal(projector.project(queued)[0]?.kind, "runtime.raw");
    assert.deepEqual(projector.project(handled), [
      { kind: "turn.settled", requestId: "turn-handled", raw: handled },
    ]);
  });
  for (const runtime of ["pi", "omp"] as const) {
    it(`settles delayed ${runtime} local-only prompt results without an outcome`, () => {
      const projector = new PiFamilyEventProjector(runtime);
      const localOnly = {
        type: "prompt_result",
        id: `${runtime}-local-only`,
        accepted: true,
        agentInvoked: false,
      };
      assert.deepEqual(projector.project(localOnly), [
        { kind: "turn.settled", requestId: `${runtime}-local-only`, raw: localOnly },
      ]);
    });
  }
  it("projects Pi extension UI requests through the portable request contract", () => {
    const projector = new PiFamilyEventProjector("pi");
    assert.deepEqual(
      projector.project({
        type: "extension_ui_request",
        id: "pi-confirm-1",
        method: "confirm",
        title: "Approve",
        message: "Continue?",
      }),
      [
        {
          kind: "ui.request",
          request: {
            kind: "confirm",
            requestId: "pi-confirm-1",
            title: "Approve",
            message: "Continue?",
          },
          raw: {
            type: "extension_ui_request",
            id: "pi-confirm-1",
            method: "confirm",
            title: "Approve",
            message: "Continue?",
          },
        },
      ],
    );
  });

  it("projects OMP automatic compaction and retry lifecycle without settling a turn", () => {
    const projector = new PiFamilyEventProjector("omp");
    const events = [
      { type: "auto_compaction_start" },
      { type: "auto_compaction_end" },
      { type: "auto_retry_start" },
      { type: "auto_retry_end" },
      { type: "retry_fallback_applied" },
      { type: "retry_fallback_succeeded" },
    ] as const;
    const projectedKinds = events.map((event) => projector.project(event)[0]?.kind);
    assert.deepEqual(projectedKinds, [
      "compaction.started",
      "compaction.completed",
      "retry.scheduled",
      "retry.scheduled",
      "retry.scheduled",
      "retry.scheduled",
    ]);
    assert.equal(projectedKinds.includes("turn.settled"), false);
  });

  it("bounds unknown-event diagnostics without changing the raw event projection", () => {
    const projector = new PiFamilyEventProjector("omp", { maxUnknownEvents: 2 });
    const first = { type: "future_one", payload: { opaque: 1 } };
    const second = { type: "future_two", payload: { opaque: 2 } };
    const third = { type: "future_three", payload: { opaque: 3 } };
    assert.deepEqual(projector.project(first), [{ kind: "runtime.raw", event: first }]);
    projector.project(second);
    projector.project(third);
    assert.deepEqual(projector.snapshotUnknownEvents(), [second, third]);
    assert.deepEqual(projector.diagnostics(), {
      retainedUnknownEvents: 2,
      droppedUnknownEvents: 1,
      taskSnapshots: 0,
      activeTasks: 0,
    });
  });

  it("maps Pi host-task lifecycle frames and preserves hierarchy, usage, and handles", () => {
    const projector = new PiFamilyEventProjector("pi");
    projector.project({
      type: "host_task_started",
      sequence: 1,
      task: {
        id: "parent",
        kind: "workflow",
        title: "Parent",
        toolCallId: "spawn-1",
        status: "running",
      },
    });
    const started = projector.project({
      type: "host_task_started",
      sequence: 2,
      task: {
        id: "child",
        kind: "job",
        title: "Child",
        parentTaskId: "parent",
        parentToolCallId: "spawn-1",
        status: "running",
        usage: { inputTokens: 3 },
        workflow: { name: "build", phaseIndex: 1, phaseTitle: "Compile", agentIndex: 0 },
        runHandles: { jobId: "job-1", outputPath: "/tmp/out" },
      },
    });
    assert.equal(started[0]?.kind, "task.started");
    const progress = projector.project({
      type: "host_task_progress",
      sequence: 3,
      task: {
        id: "child",
        kind: "job",
        title: "Child",
        status: "running",
        summary: "halfway",
        usage: { outputTokens: 5 },
      },
    });
    assert.equal(progress[0]?.kind, "task.progress");
    const completed = projector.project({
      type: "host_task_failed",
      sequence: 4,
      task: { id: "child", kind: "job", title: "Child", status: "failed", error: "failed" },
    });
    assert.equal(completed[0]?.kind, "task.completed");
    const snapshot = projector.snapshotTasks().find((task) => task.id === "child");
    assert.equal(snapshot?.parentTaskId, "parent");
    assert.equal(snapshot?.parentToolCallId, "spawn-1");
    assert.deepEqual(snapshot?.usage, { outputTokens: 5 });
    assert.deepEqual(snapshot?.workflow, {
      name: "build",
      phaseIndex: 1,
      phaseTitle: "Compile",
      agentIndex: 0,
    });
    assert.deepEqual(snapshot?.runHandles, { jobId: "job-1", outputPath: "/tmp/out" });
  });

  it("correlates actual OMP nested progress frames with one durable subagent", () => {
    const projector = new PiFamilyEventProjector("omp");
    const started = projector.project({
      type: "subagent_lifecycle",
      payload: {
        id: "child",
        index: 0,
        agent: "sonic",
        agentSource: "built-in",
        status: "running",
        parentToolCallId: "spawn-1",
        sessionFile: "[normalized:path:1]",
        detached: false,
      },
    });
    const progress = projector.project({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "sonic",
        agentSource: "built-in",
        assignment: "Return the marker",
        task: "Return the marker",
        parentToolCallId: "spawn-1",
        sessionFile: "[normalized:path:1]",
        detached: false,
        progress: {
          id: "child",
          index: 0,
          agent: "sonic",
          agentSource: "built-in",
          assignment: "Return the marker",
          task: "Return the marker",
          status: "running",
          resolvedModel: "openai-codex/gpt-5.4",
          contextTokens: 123,
          cost: 0.01,
          durationMs: 42,
          toolCount: 2,
        },
      },
    });
    const nestedEvent = projector.project({
      type: "subagent_event",
      payload: { id: "child", event: { type: "message_update" } },
    });
    const completed = projector.project({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "sonic",
        agentSource: "built-in",
        parentToolCallId: "spawn-1",
        sessionFile: "[normalized:path:1]",
        progress: {
          id: "child",
          index: 0,
          agent: "sonic",
          agentSource: "built-in",
          status: "completed",
          resolvedModel: "openai-codex/gpt-5.4",
          contextTokens: 144,
          cost: 0.02,
          durationMs: 84,
          toolCount: 2,
        },
      },
    });

    assert.equal(started[0]?.kind, "task.started");
    assert.equal(progress[0]?.kind, "task.progress");
    assert.equal(nestedEvent[0]?.kind, "task.progress");
    assert.equal(completed[0]?.kind, "task.completed");
    assert.lengthOf(projector.snapshotTasks(), 1);
    assert.equal(projector.diagnostics().activeTasks, 0);
    assert.deepEqual(projector.snapshotTasks()[0], {
      id: "child",
      kind: "subagent",
      title: "Return the marker",
      status: "completed",
      parentToolCallId: "spawn-1",
      role: "sonic",
      description: "Return the marker",
      model: "openai-codex/gpt-5.4",
      usage: {
        contextTokens: 144,
        costUsd: 0.02,
        durationMs: 84,
        toolCalls: 2,
      },
      runHandles: { sessionFile: "[normalized:path:1]" },
      detached: false,
    });
  });

  it("projects nested OMP task-tool progress as a child subagent", () => {
    const projector = new PiFamilyEventProjector("omp");
    projector.project({
      type: "subagent_lifecycle",
      payload: {
        id: "parent",
        agent: "task",
        status: "started",
        runId: "parent:run-1",
        detached: true,
      },
    });

    const projected = projector.project({
      type: "subagent_event",
      payload: {
        id: "parent",
        event: {
          type: "tool_execution_update",
          toolName: "task",
          toolCallId: "nested-spawn",
          partialResult: {
            details: {
              progress: [
                {
                  id: "child",
                  agent: "sonic",
                  task: "Hold for cancellation",
                  status: "running",
                },
              ],
            },
          },
        },
      },
    });

    assert.deepEqual(
      projected.map((event) => event.kind),
      ["task.progress", "task.started"],
    );
    const parent = projector.snapshotTasks().find((task) => task.id === "parent");
    const child = projector.snapshotTasks().find((task) => task.id === "child");
    assert.equal(parent?.detached, true);
    assert.equal(parent?.runHandles?.runId, "parent:run-1");
    assert.equal(child?.parentTaskId, "parent");
    assert.equal(child?.parentToolCallId, "nested-spawn");
    assert.equal(child?.status, "running");
  });

  it("holds parent settlement until every child is terminal", () => {
    const projector = new PiFamilyEventProjector("omp");
    projector.project({
      type: "subagent_lifecycle",
      id: "parent",
      status: "running",
      toolCallId: "spawn-1",
    });
    projector.project({
      type: "subagent_lifecycle",
      id: "child",
      status: "running",
      parentToolCallId: "spawn-1",
    });

    const held = projector.project({
      type: "subagent_lifecycle",
      id: "parent",
      status: "completed",
    });
    assert.equal(held[0]?.kind, "task.progress");
    if (held[0]?.kind === "task.progress") assert.equal(held[0].task.status, "waiting");

    const settled = projector.project({
      type: "subagent_lifecycle",
      id: "child",
      status: "completed",
    });
    assert.deepEqual(
      settled.map((event) => event.kind),
      ["task.completed", "task.completed"],
    );
    const snapshots = projector.snapshotTasks();
    assert.equal(snapshots.find((task) => task.id === "parent")?.status, "completed");
    assert.equal(snapshots.find((task) => task.id === "child")?.parentTaskId, "parent");
  });
});
