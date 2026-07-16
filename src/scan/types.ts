import type { ApiResponseMeta, IdLike, JsonObject } from "../types.js";

export type ScopeScanStatus = "running" | "paused_retryable" | "complete" | "partial" | "cancelled" | "failed" | "expired";

export interface ScopeScanPolicy {
  caseSensitive: boolean;
  includeFiles: boolean;
  includeFolders: boolean;
  matchFields: Array<"name" | "path">;
  maxDepth: number;
  maxItems: number;
  pageCapacity: number;
  queries: string[];
}

export interface ScopeScanFrontier {
  depth: number;
  folderId: string;
  pageId: number;
  pathDisplay: string;
}

export interface ScopeScanState {
  accessIdentityRef: string;
  artifactToken: string;
  completedPageKeys: string[];
  createdAt: string;
  expiresAt: string;
  externalEnterpriseId?: string;
  fileCount: number;
  folderCount: number;
  frontier: ScopeScanFrontier[];
  incompleteReasons: string[];
  lastError?: JsonObject;
  observationStartedAt: string;
  observationUpdatedAt: string;
  pageReceiptCount: number;
  pageAttempts: Record<string, number>;
  policy: ScopeScanPolicy;
  policyHash: string;
  revision: number;
  rootFolder: JsonObject;
  rootFolderId: string;
  rootObservationDigest: string;
  scanId: string;
  status: ScopeScanStatus;
  updatedAt: string;
}

export interface ScopeScanPage {
  files: JsonObject[];
  folders: JsonObject[];
  hasMore: boolean;
  meta: ApiResponseMeta;
  nextPageId?: number;
  pageCapacity?: number;
  pageCount?: number;
  pageId: number;
  paginationReliable: boolean;
  totalCount?: number;
}

export interface ScopePageReceipt {
  attempt: number;
  folderId: string;
  hasMore: boolean;
  itemCount: number;
  latencyMs: number;
  nextPageId?: number;
  observedAt: string;
  pageCapacity: number;
  pageId: number;
  providerRequestId?: string;
  responseDigest: string;
  storedItemCount: number;
}

export interface ScopePageArtifact {
  files: JsonObject[];
  folders: JsonObject[];
  pageKey: string;
  receipt: ScopePageReceipt;
}

export interface ScopeScanProvider {
  getRoot(folderId: IdLike, userId?: IdLike): Promise<{ folder: JsonObject; meta: ApiResponseMeta }>;
  listChildren(folderId: IdLike, userId: IdLike | undefined, pageId: number, pageCapacity: number, signal?: AbortSignal): Promise<ScopeScanPage>;
}
