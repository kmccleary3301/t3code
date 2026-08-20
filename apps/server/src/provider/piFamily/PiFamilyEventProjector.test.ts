import { assert, describe, it } from "vite-plus/test";

import { PiFamilyEventProjector, nativeEventId } from "./PiFamilyEventProjector.ts";

describe("Pi/OMP native event projection", () => {
  it("maps both agent-end dialects to a settled turn and keeps IDs restart-stable", () => {
    const pi = new PiFamilyEventProjector("pi");
    const event = { type: "agent_end", id: "turn-1", result: { ok: true } };
    assert.deepEqual(pi.project(event), [
      { kind: "turn.settled", requestId: "turn-1", raw: event },
    ]);
    assert.equal(nativeEventId("pi", event), nativeEventId("pi", structuredClone(event)));
    assert.notEqual(nativeEventId("pi", event), nativeEventId("omp", event));
  });
  it("projects terminal message_end without duplicating streamed assistant text", () => {
    const projector = new PiFamilyEventProjector("omp");
    const update = projector.project({
      type: "message_update",
      delta: { text: "final" },
    });
    const final = projector.project({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        stopReason: "stop",
      },
    });
    assert.deepEqual(
      update.map((event) => event.kind),
      ["message.delta"],
    );
    assert.deepEqual(
      final.map((event) => event.kind),
      ["message.completed"],
    );
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
