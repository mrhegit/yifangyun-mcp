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

/** Operational anchors are copied exactly so text-only hosts can continue safely. */
const EXACT_CONTROL_KEYS = new Set([
  "page",
  "next_action",
  "inventory",
  "inventory_id",
  "suggested_wait_ms",
  "empty_result_meaning",
  "empty_result_code",
  "selection_policy",
  "usage_policy",
  "not_for_verified_download",
  "do_not_echo_url",
  "manifest_uri",
  "receipts_uri_template",
  "outcome",
  "status",
  "verdict",
  "safe_to_claim_absence",
  "claim_allowed",
  "agent_hint"
]);

/** Decision fields are compacted but kept ahead of ordinary result samples. */
const PRIORITY_CONTROL_KEYS = new Set([
  "completeness",
  "agent_guidance",
  "agent_warnings",
  "disambiguation",
  "content_search_policy",
  "recommended_actions",
  "planning",
  "cleanup",
  "download",
  "preferred_alternatives",
  "coverage",
  "workspace",
  "scan_root",
  "agent_interpretation",
  "diagnostics",
  "version_selection_rules",
  "recommended_workflows"
]);

const DOWNLOAD_CONTROL_KEYS = new Set([
  "download_id",
  "local_path",
  "fetch_url",
  "media_type",
  "sha256",
  "sha1",
  "size_bytes",
  "expires_at"
]);

/** Sample-plane keys that may still hold full-fidelity refs when previewed. */
const NEVER_TRUNCATE_STRING_KEYS = new Set([
  "next_cursor",
  "cursor",
  "ref",
  "inventory",
  "manifest_uri",
  "receipts_uri_template",
  "file",
  "item",
  "local_path",
  "download_id",
  "fetch_url"
]);

const SAMPLE_BULK_KEYS = new Set([
  "items",
  "hits",
  "unverified_hits",
  "versions",
  "comments",
  "shares",
  "departments",
  "users",
  "groups",
  "results",
  "places",
  "profiles",
  "capabilities"
]);

function deepCloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function continuationReady(control: Record<string, unknown>): boolean {
  const page = control.page;
  const nextAction = control.next_action;
  if (!page || typeof page !== "object" || Array.isArray(page)) return false;
  const pageObj = page as Record<string, unknown>;
  if (pageObj.has_more !== true) return false;
  if (typeof pageObj.next_cursor !== "string" || pageObj.next_cursor.length === 0) return false;
  if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction)) return false;
  const action = nextAction as Record<string, unknown>;
  if (typeof action.tool !== "string" || action.tool.length === 0) return false;
  if (!action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments)) return false;
  return true;
}

function terminalPreview(value: unknown, options: PreviewOptions, depth = 0, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && NEVER_TRUNCATE_STRING_KEYS.has(parentKey)) return value;
    return value.length <= options.stringCharacters
      ? value
      : `${value.slice(0, options.stringCharacters)}...[${value.length - options.stringCharacters} characters omitted]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return {
      item_count: value.length,
      items: value.slice(0, Math.max(1, options.arrayItems)).map((entry) => terminalPreview(entry, options, depth + 1)),
      omitted_count: Math.max(0, value.length - Math.max(1, options.arrayItems))
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.slice(0, options.objectFields);
  return Object.fromEntries(kept.map(([key, entry]) => {
    if (depth >= 2 && entry !== null && typeof entry === "object") {
      if (NEVER_TRUNCATE_STRING_KEYS.has(key) && typeof entry === "string") return [key, entry];
      if (typeof entry === "string") return [key, terminalPreview(entry, options, depth + 1, key)];
      return [key, { omitted: true }];
    }
    return [key, terminalPreview(entry, options, depth + 1, key)];
  }).concat(entries.length > options.objectFields ? [["omitted_field_count", entries.length - options.objectFields]] : []));
}

function previewSample(value: unknown, options: PreviewOptions, depth = 0, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && NEVER_TRUNCATE_STRING_KEYS.has(parentKey)) return value;
    return value.length <= options.stringCharacters
      ? value
      : `${value.slice(0, options.stringCharacters)}...[${value.length - options.stringCharacters} characters omitted]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= options.depth) return terminalPreview(value, options, 0, parentKey);
  if (Array.isArray(value)) {
    return {
      item_count: value.length,
      items: value.slice(0, options.arrayItems).map((entry) => previewSample(entry, options, depth + 1)),
      omitted_count: Math.max(0, value.length - options.arrayItems)
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  // Prefer bulk sample keys and short identity fields for agent readability.
  const prioritized = [
    ...entries.filter(([key]) => SAMPLE_BULK_KEYS.has(key) || NEVER_TRUNCATE_STRING_KEYS.has(key) || key === "name" || key === "type" || key === "id" || key === "match"),
    ...entries.filter(([key]) => !SAMPLE_BULK_KEYS.has(key) && !NEVER_TRUNCATE_STRING_KEYS.has(key) && key !== "name" && key !== "type" && key !== "id" && key !== "match")
  ];
  return Object.fromEntries(prioritized.slice(0, options.objectFields).map(([key, entry]) => [key, previewSample(entry, options, depth + 1, key)]).concat(
    entries.length > options.objectFields ? [["omitted_field_count", entries.length - options.objectFields]] : []
  ));
}

export function extractControlPlane(output: Record<string, unknown>, options: PreviewOptions = PREVIEW_OPTIONS[0]!): Record<string, unknown> {
  const control: Record<string, unknown> = {};
  for (const key of EXACT_CONTROL_KEYS) {
    if (output[key] !== undefined) control[key] = deepCloneJson(output[key]);
  }
  for (const key of PRIORITY_CONTROL_KEYS) {
    if (output[key] !== undefined) control[key] = previewSample(output[key], options, 0, key);
  }
  if (output.download && typeof output.download === "object" && !Array.isArray(output.download)) {
    const download = output.download as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const key of DOWNLOAD_CONTROL_KEYS) {
      if (download[key] !== undefined) projected[key] = deepCloneJson(download[key]);
    }
    if (Object.keys(projected).length > 0) control.download = projected;
  }
  return control;
}

function extractSamplePlane(output: Record<string, unknown>): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (EXACT_CONTROL_KEYS.has(key) || PRIORITY_CONTROL_KEYS.has(key) || key === "download") continue;
    // Never copy full text preview into compact envelopes (body lives in structuredContent).
    if (key === "preview" && value && typeof value === "object" && !Array.isArray(value)) {
      const preview = value as Record<string, unknown>;
      sample[key] = {
        kind: preview.kind,
        ...(typeof preview.bytes === "number" ? { bytes: preview.bytes } : {}),
        text_omitted: true
      };
      continue;
    }
    sample[key] = value;
  }
  return sample;
}

function redactSensitiveValue(value: unknown, redactDownloadUrls: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, redactDownloadUrls));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    redactDownloadUrls && key === "download_url" && typeof entry === "string"
      ? "***redacted***"
      : redactSensitiveValue(entry, redactDownloadUrls)
  ]));
}

/** Redact sensitive URL fields from a deep clone used only for the text channel. */
export function redactSensitiveForText(output: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveValue(output, output.do_not_echo_url === true) as Record<string, unknown>;
}

function compactEnvelope(
  tool: string,
  control: Record<string, unknown>,
  samplePreview: unknown,
  originalCharacters: number,
  mode: "compact_preview" | "control_only"
) {
  return {
    status: "success",
    tool,
    text_delivery: {
      mode,
      original_characters: originalCharacters,
      full_result_available_in: "structuredContent",
      continuation_ready: continuationReady(control)
    },
    control,
    ...(mode === "compact_preview" ? { result_preview: samplePreview } : {})
  };
}

export function serializeToolText(tool: string, output: Record<string, unknown>, maxCharacters = DEFAULT_TEXT_BUDGET): string {
  const textSafe = redactSensitiveForText(output);
  const serialized = JSON.stringify(textSafe);
  if (serialized.length <= maxCharacters) return serialized;

  const sample = extractSamplePlane(textSafe);
  const originalCharacters = serialized.length;

  for (const options of PREVIEW_OPTIONS) {
    const control = extractControlPlane(textSafe, options);
    const samplePreview = previewSample(sample, options);
    const compact = JSON.stringify(compactEnvelope(tool, control, samplePreview, originalCharacters, "compact_preview"));
    if (compact.length <= maxCharacters) return compact;
  }

  const control = extractControlPlane(textSafe, PREVIEW_OPTIONS[PREVIEW_OPTIONS.length - 1]!);
  const controlOnly = JSON.stringify(compactEnvelope(tool, control, undefined, originalCharacters, "control_only"));
  if (controlOnly.length <= maxCharacters) return controlOnly;

  // Control plane must never truncate operational anchors even if over budget.
  return controlOnly;
}
