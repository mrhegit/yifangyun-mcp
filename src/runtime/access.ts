import crypto from "node:crypto";
import type { AccessContext, AppConfig, AuthorityScope } from "../types.js";
import { YifangyunError } from "../client.js";

export interface ResolvedAccess {
  context: AccessContext;
  identityRef: string;
}

export interface ResolvedScope extends ResolvedAccess {
  scope: AuthorityScope;
}

export class AccessRegistry {
  private readonly contexts: Map<string, AccessContext>;
  private readonly scopes: Map<string, AuthorityScope>;

  constructor(private readonly config: AppConfig) {
    this.contexts = new Map(config.accessContexts.map((context) => [context.id, context]));
    this.scopes = new Map(config.authorityScopes.map((scope) => [scope.id, scope]));
  }

  listContexts(): AccessContext[] {
    return [...this.contexts.values()];
  }

  listScopes(): AuthorityScope[] {
    return [...this.scopes.values()];
  }

  resolveContext(id?: string): ResolvedAccess {
    const contextId = id ?? this.config.defaultAccessContext;
    const context = this.contexts.get(contextId);
    if (!context) {
      throw new YifangyunError(`Unknown access context: ${contextId}`, {
        code: "YFY_ACCESS_CONTEXT_NOT_FOUND",
        phase: "access_context",
        suggestedAction: "Call yfy_status to inspect the configured identity and places."
      });
    }
    return { context, identityRef: this.identityRef(context) };
  }

  resolveScope(id: string): ResolvedScope {
    const scope = this.scopes.get(id);
    if (!scope) {
      throw new YifangyunError(`Unknown workspace: ${id}`, {
        code: "YFY_WORKSPACE_NOT_FOUND",
        phase: "workspace_resolution",
        suggestedAction: "Call yfy_status to list configured workspaces."
      });
    }
    return { ...this.resolveContext(scope.accessContext), scope };
  }

  private identityRef(context: AccessContext): string {
    return crypto
      .createHmac("sha256", this.config.clientSecret)
      .update([this.config.enterpriseId, context.userId, context.externalEnterpriseId ?? "", this.config.apiBaseUrl].join(":"))
      .digest("hex")
      .slice(0, 24);
  }
}
