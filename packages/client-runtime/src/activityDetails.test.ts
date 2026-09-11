import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseActivityDetail } from "./activityDetails.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAATUlEQVR4nGMQqXj2Hx9+tkUEL6ZUP8OoA0ZDYDQEBjwEaG0BIf2jDhgNgdEQGPgQGPCCaNQBoyEwGgIDHgIDXhCNOmA0BEZD4NkAZ0MAy+s8l2OjN+IAAAAASUVORK5CYII=";

describe("parseActivityDetail", () => {
  it("renders native raster data without automatically loading provider-controlled URLs", () => {
    const remoteImage = { type: "image_url", image_url: "https://tracker.example/pixel.png" };
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("native-image-result"),
      tone: "info",
      kind: "tool.completed",
      summary: "Read images",
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        data: {
          item: {
            result: {
              content: [remoteImage, { type: "image", mimeType: "image/png", data: PNG }],
            },
          },
        },
      },
    };

    expect(parseActivityDetail(activity).sections).toEqual([
      {
        title: "Result",
        blocks: [
          { kind: "structured", value: remoteImage },
          { kind: "image", source: `data:image/png;base64,${PNG}`, alt: "Tool result image" },
        ],
      },
    ]);
  });
});
