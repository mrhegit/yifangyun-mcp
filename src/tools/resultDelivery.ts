const DEFAULT_TEXT_BUDGET = 12_000;

interface PreviewOptions {
  arrayItems: number;
  depth: number;
  objectFields: number;
  stringCharacters: number;
}

const PREVIEW_OPTIONS: PreviewOptions[] = [
  { arrayItems: 5, depth: 5, objectFields: 40, stringCharacters: 512 },
  { arrayItems: 3, depth: 4, objectFields: 25, stringCharacters: 256 },
  { arrayItems: 1, depth: 3, objectFields: 15, stringCharacters: 128 }
];

function preview(value: unknown, options: PreviewOptions, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length <= options.stringCharacters
      ? value
      : `${value.slice(0, options.stringCharacters)}...[${value.length - options.stringCharacters} characters omitted]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= options.depth) return Array.isArray(value) ? { item_count: value.length, omitted: true } : { omitted: true };
  if (Array.isArray(value)) {
    return {
      item_count: value.length,
      items: value.slice(0, options.arrayItems).map((entry) => preview(entry, options, depth + 1)),
      omitted_count: Math.max(0, value.length - options.arrayItems)
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(entries.slice(0, options.objectFields).map(([key, entry]) => [key, preview(entry, options, depth + 1)]).concat(
    entries.length > options.objectFields ? [["omitted_field_count", entries.length - options.objectFields]] : []
  ));
}

function compactEnvelope(tool: string, output: Record<string, unknown>, originalCharacters: number, options: PreviewOptions) {
  return {
    status: "success",
    tool,
    text_delivery: {
      mode: "compact_preview",
      original_characters: originalCharacters,
      full_result_available_in: "structuredContent"
    },
    result_preview: preview(output, options)
  };
}

export function serializeToolText(tool: string, output: Record<string, unknown>, maxCharacters = DEFAULT_TEXT_BUDGET): string {
  const serialized = JSON.stringify(output);
  if (serialized.length <= maxCharacters) return serialized;
  for (const options of PREVIEW_OPTIONS) {
    const compact = JSON.stringify(compactEnvelope(tool, output, serialized.length, options));
    if (compact.length <= maxCharacters) return compact;
  }
  const metadataOnly = JSON.stringify({
    status: "success",
    tool,
    text_delivery: {
      mode: "metadata_only",
      original_characters: serialized.length,
      full_result_available_in: "structuredContent"
    },
    top_level_fields: Object.keys(output),
    page: output.page,
    next_action: output.next_action,
    completeness: output.completeness
  });
  if (metadataOnly.length <= maxCharacters) return metadataOnly;
  return JSON.stringify({
    status: "success",
    tool,
    text_delivery: { mode: "metadata_only", original_characters: serialized.length, full_result_available_in: "structuredContent" },
    top_level_fields: Object.keys(output)
  });
}
