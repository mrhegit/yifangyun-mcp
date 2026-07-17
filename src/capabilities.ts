import crypto from "node:crypto";
import type { AppConfig, Toolset, WorkflowProfile } from "./types.js";

const PROFILE_REQUIREMENTS: Record<WorkflowProfile, { requiresScope: boolean; toolsets: Toolset[] }> = {
  tender: { requiresScope: true, toolsets: ["drive", "workspace", "inventory", "evidence"] }
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

export function configFingerprint(config: Pick<AppConfig, "accessContexts" | "authorityScopes" | "clientSecret" | "defaultAccessContext" | "toolsets" | "transport" | "workflowProfiles">): string {
  const stable = JSON.stringify({
    access_contexts: config.accessContexts.map((context) => ({ id: context.id, user_id: context.userId, external_enterprise_id: context.externalEnterpriseId ?? null })),
    workspaces: config.authorityScopes.map((scope) => ({ id: scope.id, root_folder_id: scope.rootFolderId, access_context: scope.accessContext, tags: scope.tags })),
    default_access_context: config.defaultAccessContext,
    toolsets: config.toolsets,
    transport: config.transport ?? "stdio",
    workflow_profiles: config.workflowProfiles
  });
  return crypto.createHmac("sha256", config.clientSecret).update(stable).digest("hex");
}
