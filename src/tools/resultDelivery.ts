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

const ANCHOR_FIELDS = new Set([
  "id", "ref", "name", "type", "file", "item", "inventory", "workspace", "path", "path_display", "provider_path_chain", "relative_ancestor_chain",
  "page", "next_action", "completeness", "view", "outcome", "status", "verdict",
  "agent_warnings", "coverage", "must_release", "content_delivery", "resource", "assurance", "match", "trust",
  "disambiguation_required", "claim_allowed", "unverified_hits", "agent_guidance", "suggested_wait_ms",
  "agent_interpretation", "diagnostics", "contact_policy", "version_selection_rules",
  "safe_to_claim_absence", "preview_complete", "usage", "inventory_id", "scan_root"
]);

function terminalPreview(value: unknown, options: PreviewOptions, depth = 0): unknown {
  if (typeof value === "string") return value.length <= options.stringCharacters ? value : `${value.slice(0, options.stringCharacters)}...[${value.length - options.stringCharacters} characters omitted]`;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return { item_count: value.length, items: value.slice(0, Math.max(1, options.arrayItems)).map((entry) => terminalPreview(entry, options, depth + 1)), omitted_count: Math.max(0, value.length - Math.max(1, options.arrayItems)) };
  const entries = Object.entries(value as Record<string, unknown>);
  const anchors = entries.filter(([key, entry]) => ANCHOR_FIELDS.has(key) || entry === null || typeof entry !== "object").slice(0, options.objectFields);
  return Object.fromEntries(anchors.map(([key, entry]) => [key, depth < 2 ? terminalPreview(entry, options, depth + 1) : entry === null || typeof entry !== "object" ? terminalPreview(entry, options, depth + 1) : { omitted: true }]));
}

function preview(value: unknown, options: PreviewOptions, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length <= options.stringCharacters
      ? value
      : `${value.slice(0, options.stringCharacters)}...[${value.length - options.stringCharacters} characters omitted]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= options.depth) return terminalPreview(value, options);
  if (Array.isArray(value)) {
    return {
      item_count: value.length,
      items: value.slice(0, options.arrayItems).map((entry) => preview(entry, options, depth + 1)),
      omitted_count: Math.max(0, value.length - options.arrayItems)
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const prioritized = [...entries.filter(([key]) => ANCHOR_FIELDS.has(key)), ...entries.filter(([key]) => !ANCHOR_FIELDS.has(key))];
  return Object.fromEntries(prioritized.slice(0, options.objectFields).map(([key, entry]) => [key, preview(entry, options, depth + 1)]).concat(
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
  const controlAnchors = controlAnchorsFromOutput(output);
  const metadataOnly = JSON.stringify({
    status: "success",
    tool,
    text_delivery: {
      mode: "metadata_only",
      original_characters: serialized.length,
      full_result_available_in: "structuredContent"
    },
    top_level_fields: Object.keys(output),
    identity: Object.fromEntries(Object.entries(output).filter(([key]) => ["file", "item", "inventory", "inventory_id", "workspace", "outcome", "status", "verdict"].includes(key))),
    ...controlAnchors,
    page: output.page,
    next_action: output.next_action,
    completeness: output.completeness
  });
  if (metadataOnly.length <= maxCharacters) return metadataOnly;
  return JSON.stringify({
    status: "success",
    tool,
    text_delivery: { mode: "metadata_only", original_characters: serialized.length, full_result_available_in: "structuredContent" },
    top_level_fields: Object.keys(output),
    identity: Object.fromEntries(Object.entries(output).filter(([key]) => ["file", "item", "inventory", "inventory_id", "workspace", "outcome", "status", "verdict"].includes(key))),
    ...controlAnchors,
    page: output.page,
    next_action: output.next_action,
    completeness: output.completeness
  });
}

/** Keep release/fetch/guidance anchors even when the text channel collapses to metadata_only. */
function controlAnchorsFromOutput(output: Record<string, unknown>): Record<string, unknown> {
  const anchors: Record<string, unknown> = {};
  if (output.must_release === true) anchors.must_release = true;
  if (output.content_delivery && typeof output.content_delivery === "object" && !Array.isArray(output.content_delivery)) {
    const delivery = output.content_delivery as Record<string, unknown>;
    anchors.content_delivery = {
      mode: delivery.mode,
      resource_fetch_required: delivery.resource_fetch_required,
      embedded_resource_in_tool_result: delivery.embedded_resource_in_tool_result,
      still_must_release: delivery.still_must_release === true ? true : undefined,
      next_step: typeof delivery.next_step === "string" ? delivery.next_step : undefined
    };
  }
  if (output.resource && typeof output.resource === "object" && !Array.isArray(output.resource)) {
    const resource = output.resource as Record<string, unknown>;
    anchors.resource = {
      ...(typeof resource.resource_uri === "string" ? { resource_uri: resource.resource_uri } : {}),
      ...(typeof resource.delivery === "string" ? { delivery: resource.delivery } : {}),
      ...(resource.must_release === true ? { must_release: true } : {})
    };
  }
  if (Array.isArray(output.agent_warnings)) anchors.agent_warnings = output.agent_warnings.slice(0, 8);
  if (output.agent_guidance && typeof output.agent_guidance === "object") anchors.agent_guidance = output.agent_guidance;
  if (typeof output.suggested_wait_ms === "number") anchors.suggested_wait_ms = output.suggested_wait_ms;
  return anchors;
}
