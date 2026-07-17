import type { ApiResponseMeta, IdLike, JsonObject } from "../types.js";

export type ScopeScanStatus = "running" | "paused_retryable" | "complete" | "partial" | "cancelled" | "failed" | "expired";

export interface ScopeScanPolicy {
  caseSensitive: boolean;
  includeFiles: boolean;
  includeFolders: boolean;
  matchFields: Array<"name" | "path">;
  maxItemDepth: number;
  maxItems: number;
  pageCapacity: number;
}

export interface ScopeScanFrontier {
  attempt: number;
  depth: number;
  folderId: string;
  pageId: number;
  pathDisplay: string;
}

export interface ScopeScanState {
  accessContextId: string;
  accessIdentityRef: string;
  artifactToken: string;
  createdAt: string;
  expiresAt: string;
  externalEnterpriseId?: string;
  fileCount: number;
  folderCount: number;
  frontierCount: number;
  incompleteReasons: string[];
  lastError?: JsonObject;
  observationStartedAt: string;
  observationUpdatedAt: string;
  pageReceiptCount: number;
  policy: ScopeScanPolicy;
  policyHash: string;
  receiptDigest: string;
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
  pageCount?: number;
  pageId: number;
  paginationReliable: boolean;
  providerRequestId?: string;
  responseDigest: string;
  storedItemCount: number;
  totalCount?: number;
}

export interface ScopePageArtifact {
  files: JsonObject[];
  folders: JsonObject[];
  pageKey: string;
  receipt: ScopePageReceipt;
}

export interface ScopeSeenItem {
  digest: string;
  id: string;
  type: "file" | "folder";
}

export interface ScopeItemCursor {
  itemId: string;
  revision: number;
  sortPath: string;
  total: number;
}

export interface ScopeItemPage {
  items: JsonObject[];
  nextCursor?: ScopeItemCursor;
  total: number;
}

export interface ScopeScanProvider {
  getRoot(folderId: IdLike, userId?: IdLike, signal?: AbortSignal): Promise<{ folder: JsonObject; meta: ApiResponseMeta }>;
  listChildren(folderId: IdLike, userId: IdLike | undefined, pageId: number, pageCapacity: number, signal?: AbortSignal): Promise<ScopeScanPage>;
}

export interface ScopeScanRepository {
  close(): void;
  commitPage(scanId: string, artifact: ScopePageArtifact, seenItems: ScopeSeenItem[], state: ScopeScanState, current: ScopeScanFrontier, append: ScopeScanFrontier[]): Promise<void>;
  create(state: ScopeScanState, frontier: ScopeScanFrontier[]): Promise<void>;
  findSeenItems(scanId: string, itemIds: string[]): Promise<Map<string, ScopeSeenItem>>;
  findReusable(accessIdentityRef: string, rootFolderId: string, policyHash: string): Promise<ScopeScanState | undefined>;
  hasPage(scanId: string, pageKey: string): Promise<boolean>;
  listItems(scanId: string, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number): Promise<ScopeItemPage>;
  listPages(scanId: string): Promise<ScopePageArtifact[]>;
  listReceiptSummary(scanId: string, limit: number): Promise<{ receipts: ScopePageReceipt[]; total: number }>;
  listRunnable(): Promise<ScopeScanState[]>;
  load(scanId: string): Promise<ScopeScanState>;
  makeExpiry(now?: number): string;
  observedItemCount(scanId: string, folderId: string): Promise<number>;
  peekFrontier(scanId: string, limit: number): Promise<ScopeScanFrontier[]>;
  pruneExpired(): Promise<void>;
  removeFrontier(scanId: string, cursor: ScopeScanFrontier, state: ScopeScanState): Promise<void>;
  save(state: ScopeScanState): Promise<void>;
  searchItems(scanId: string, queries: Array<{ normalized: string; original: string }>, matchFields: Array<"name" | "path">, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number, caseSensitive: boolean): Promise<ScopeItemPage>;
  storageBytes(): number;
  updateFrontier(scanId: string, cursor: ScopeScanFrontier): Promise<void>;
  withLock<T>(scanId: string, work: () => Promise<T>): Promise<T>;
}
