import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  TextGenerationError,
  ThreadId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";

const PI_FAMILY_TEXT_GENERATION_TIMEOUT_MS = 180_000;

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

let textGenerationThreadCounter = 0;

const nextTextGenerationThreadId = (): ThreadId =>
  ThreadId.make(`t3-text-generation-${(textGenerationThreadCounter++).toString(36)}`);

const isTerminalEventFor = (
  event: ProviderRuntimeEvent,
  threadId: ThreadId,
  turnId: string,
): boolean =>
  String(event.threadId) === String(threadId) &&
  ((event.type === "turn.completed" && String(event.turnId) === turnId) ||
    event.type === "runtime.error" ||
    event.type === "session.exited");

const eventOutput = (events: ReadonlyArray<ProviderRuntimeEvent>): string =>
  events
    .filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
        event.type === "content.delta" && event.payload.streamKind === "assistant_text",
    )
    .map((event) => event.payload.delta)
    .join("")
    .trim();

/**
 * Build text-generation operations on a dedicated native adapter.
 *
 * Text generation uses the same native `prompt` contract as an interactive
 * turn, but gets its own adapter so its event consumer cannot steal events
 * from the provider adapter used by the live chat session.
 */
export const makePiFamilyTextGeneration = (input: {
  readonly provider: ProviderDriverKind;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
}): TextGeneration.TextGeneration["Service"] => {
  const runJson = <S extends Schema.Top>(request: {
    readonly operation: TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: Parameters<
      TextGeneration.TextGeneration["Service"]["generateBranchName"]
    >[0]["modelSelection"];
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const threadId = nextTextGenerationThreadId();
      let turn: ProviderTurnStartResult | undefined;
      yield* input.adapter
        .startSession({
          threadId,
          provider: input.provider,
          runtimeMode: "approval-required",
          cwd: request.cwd,
          providerInstanceId: request.modelSelection.instanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: request.operation,
                detail: `Failed to start native ${input.provider} text-generation session.`,
                cause,
              }),
          ),
        );

      const generation = Effect.gen(function* () {
        turn = yield* input.adapter
          .sendTurn({
            threadId,
            input: request.prompt,
            modelSelection: request.modelSelection,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: request.operation,
                  detail: `Failed to prompt native ${input.provider} for text generation.`,
                  cause,
                }),
            ),
          );

        const events = yield* input.adapter.streamEvents.pipe(
          Stream.filter((event) => String(event.threadId) === String(threadId)),
          Stream.takeUntil((event) => isTerminalEventFor(event, threadId, String(turn?.turnId))),
          Stream.runCollect,
          Effect.timeoutOption(PI_FAMILY_TEXT_GENERATION_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: request.operation,
                    detail: `Native ${input.provider} text generation timed out.`,
                  }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
        );

        const terminal = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.turnId) === String(turn?.turnId),
        );
        if (terminal && terminal.payload.state !== "completed") {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: `Native ${input.provider} text generation ended with state '${terminal.payload.state}'.`,
          });
        }

        const runtimeError = events.find((event) => event.type === "runtime.error");
        if (runtimeError?.type === "runtime.error") {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: runtimeError.payload.message,
            cause: runtimeError.payload.detail,
          });
        }

        const rawOutput = eventOutput(events);
        if (rawOutput.length === 0) {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: `Native ${input.provider} returned empty text-generation output.`,
          });
        }

        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
        return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: request.operation,
                detail: `Native ${input.provider} returned invalid structured output.`,
                cause,
              }),
            ),
          ),
        );
      }).pipe(Effect.ensuring(input.adapter.stopSession(threadId).pipe(Effect.ignore)));
      return yield* generation;
    }).pipe(
      Effect.catch((cause) =>
        Schema.is(TextGenerationError)(cause)
          ? Effect.fail(cause)
          : Effect.fail(
              new TextGenerationError({
                operation: request.operation,
                detail: `Native ${input.provider} text generation failed.`,
                cause,
              }),
            ),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiFamilyTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiFamilyTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        changeRequestTemplate: input.changeRequestTemplate,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiFamilyTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiFamilyTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  };
};
