import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type ActivityDetailBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly source: string; readonly alt: string }
  | { readonly kind: "structured"; readonly value: unknown };

export interface ActivityDetailSection {
  readonly title: string;
  readonly blocks: ReadonlyArray<ActivityDetailBlock>;
}

export interface ParsedActivityDetail {
  readonly sections: ReadonlyArray<ActivityDetailSection>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: ReadonlyArray<string>
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function imageBlock(record: Record<string, unknown>): ActivityDetailBlock | null {
  const nestedSource = asRecord(record.source);
  const data = record.data ?? nestedSource?.data;
  const mimeType = record.mimeType ?? nestedSource?.media_type;
  let source: string | null = null;
  if (
    typeof data === "string" &&
    typeof mimeType === "string" &&
    /^image\/(?:png|jpeg|webp|gif|avif|bmp|tiff)$/i.test(mimeType)
  ) {
    source = `data:${mimeType};base64,${data}`;
  } else {
    const imageUrl = record.image_url ?? record.imageUrl ?? record.url ?? record.source;
    const candidate = typeof imageUrl === "string" ? imageUrl : asRecord(imageUrl)?.url;
    if (
      typeof candidate === "string" &&
      /^data:image\/(?:png|jpeg|webp|gif|avif|bmp|tiff);base64,/i.test(candidate)
    ) {
      source = candidate;
    }
  }
  return source === null
    ? null
    : {
        kind: "image",
        source,
        alt: stringField(record, "alt", "name", "title") ?? "Tool result image",
      };
}

function resultBlocks(result: unknown): ReadonlyArray<ActivityDetailBlock> {
  if (typeof result === "string") {
    return [{ kind: "text", text: result }];
  }
  const resultRecord = asRecord(result);
  if (resultRecord === null) {
    return [{ kind: "structured", value: result }];
  }
  const content = resultRecord.content;
  if (typeof content === "string") {
    const metadata = Object.fromEntries(
      Object.entries(resultRecord).filter(([key]) => key !== "content"),
    );
    return [
      { kind: "text", text: content },
      ...(Object.keys(metadata).length > 0
        ? [{ kind: "structured" as const, value: metadata }]
        : []),
    ];
  }
  if (Array.isArray(content)) {
    const blocks: ActivityDetailBlock[] = [];
    for (const entryValue of content) {
      const entry = asRecord(entryValue);
      if (entry?.type === "text" && typeof entry.text === "string") {
        blocks.push({ kind: "text", text: entry.text });
        continue;
      }
      if (entry?.type === "image" || entry?.type === "image_url") {
        const image = imageBlock(entry);
        blocks.push(image ?? { kind: "structured", value: entryValue });
        continue;
      }
      // Unknown provider blocks remain inspectable instead of disappearing.
      blocks.push({ kind: "structured", value: entryValue });
    }
    const metadata = Object.fromEntries(
      Object.entries(resultRecord).filter(([key]) => key !== "content"),
    );
    if (Object.keys(metadata).length > 0) {
      blocks.push({ kind: "structured", value: metadata });
    }
    return blocks.length > 0 ? blocks : [{ kind: "structured", value: result }];
  }
  return [{ kind: "structured", value: result }];
}

function section(title: string, blocks: ReadonlyArray<ActivityDetailBlock>): ActivityDetailSection {
  return { title, blocks };
}

export function parseActivityDetail(activity: OrchestrationThreadActivity): ParsedActivityDetail {
  const payload = asRecord(activity.payload);
  if (payload === null) {
    return { sections: [section("Activity", [{ kind: "structured", value: activity.payload }])] };
  }
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  if (data === null || item === null) {
    return { sections: [section("Activity", [{ kind: "structured", value: payload }])] };
  }

  const sections: ActivityDetailSection[] = [];
  if (item.input !== undefined) {
    sections.push(section("Input", [{ kind: "structured", value: item.input }]));
  }
  if (item.result !== undefined) {
    sections.push(section("Result", resultBlocks(item.result)));
  }
  const metadata = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "input" && key !== "result"),
  );
  if (Object.keys(metadata).length > 0) {
    sections.push(section("Tool metadata", [{ kind: "structured", value: metadata }]));
  }
  const additionalData = Object.fromEntries(
    Object.entries(data).filter(
      ([key]) => key !== "item" && (key !== "rawOutput" || item.result === undefined),
    ),
  );
  if (Object.keys(additionalData).length > 0) {
    sections.push(section("Additional data", [{ kind: "structured", value: additionalData }]));
  }
  return {
    sections:
      sections.length > 0
        ? sections
        : [section("Activity", [{ kind: "structured", value: payload }])],
  };
}
