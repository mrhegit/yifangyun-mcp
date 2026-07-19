import crypto from "node:crypto";
import type { AppConfig, Toolset, WorkflowProfile } from "./types.js";
import { CONTRACT_VERSION } from "./version.js";

const PROFILE_REQUIREMENTS: Record<WorkflowProfile, { requiresScope: boolean; toolsets: Toolset[] }> = {
  tender: { requiresScope: true, toolsets: ["drive", "workspace", "inventory"] }
};

export interface ProfileReadiness {
  missing_configuration: string[];
  missing_toolsets: Toolset[];
  profile: WorkflowProfile;
  ready: boolean;
}

export function profileReadiness(config: Pick<AppConfig, "authorityScopes" | "toolsets" | "workflowProfiles">): ProfileReadiness[] {
  return config.workflowProfiles.map((profile) => {
    const requirement = PROFILE_REQUIREMENTS[profile];
    const missingToolsets = requirement.toolsets.filter((toolset) => !config.toolsets.includes(toolset));
    const missingConfiguration = requirement.requiresScope && config.authorityScopes.length === 0 ? ["workspace"] : [];
    return { profile, ready: missingToolsets.length === 0 && missingConfiguration.length === 0, missing_toolsets: missingToolsets, missing_configuration: missingConfiguration };
  });
}

export function assertProfilesReady(config: Pick<AppConfig, "authorityScopes" | "toolsets" | "workflowProfiles">): void {
  const unavailable = profileReadiness(config).filter((profile) => !profile.ready);
  if (unavailable.length > 0) {
    throw new Error(`Workflow profile configuration is incomplete: ${JSON.stringify(unavailable)}`);
  }
}

export function configFingerprint(config: AppConfig): string {
  const stable = JSON.stringify({
    contract_version: CONTRACT_VERSION,
    access_contexts: config.accessContexts.map((context) => ({ id: context.id, user_id: context.userId, external_enterprise_id: context.externalEnterpriseId ?? null })),
    workspaces: config.authorityScopes.map((scope) => ({ id: scope.id, root_folder_id: scope.rootFolderId, access_context: scope.accessContext, tags: scope.tags })),
    default_access_context: config.defaultAccessContext,
    api_base_url: config.apiBaseUrl,
    oauth_base_url: config.oauthBaseUrl,
    max_page_capacity: config.maxPageCapacity,
    max_download_bytes: config.maxDownloadBytes,
    max_state_bytes: config.maxStateBytes ?? null,
    max_temp_bytes: config.maxTempBytes ?? null,
    request_timeout_ms: config.requestTimeoutMs,
    retry_base_delay_ms: config.retryBaseDelayMs,
    retry_max_attempts: config.retryMaxAttempts,
    max_retry_delay_ms: config.maxRetryDelayMs ?? null,
    max_concurrent_provider_requests: config.maxConcurrentProviderRequests ?? null,
    max_concurrent_requests_per_identity: config.maxConcurrentRequestsPerIdentity ?? null,
    inventory_concurrency: config.snapshotConcurrency ?? null,
    inventory_ttl_seconds: config.snapshotTtlSeconds ?? null,
    download_ttl_seconds: config.tempFileTtlSeconds,
    download_expose_local_path: config.downloadExposeLocalPath ?? null,
    download_staged_http_enabled: config.downloadStagedHttpEnabled ?? null,
    download_staged_max_concurrent_reads: config.downloadStagedMaxConcurrentReads ?? null,
    download_staged_max_fetches: config.downloadStagedMaxFetches ?? null,
    download_staged_public_base_url: config.downloadStagedPublicBaseUrl ?? null,
    text_preview_max_bytes: config.textPreviewMaxBytes ?? null,
    upload_enabled: Boolean(config.uploadRootDir),
    toolsets: config.toolsets,
    transport: config.transport ?? "stdio",
    workflow_profiles: config.workflowProfiles
  });
  return crypto.createHmac("sha256", config.clientSecret).update(stable).digest("hex");
}
