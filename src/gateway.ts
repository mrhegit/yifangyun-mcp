import type { AccessRegistry, ResolvedAccess } from "./runtime/access.js";
import type { ApiJsonResponse, IdLike, JsonValue } from "./types.js";
import type { ScopeScanPage, ScopeScanProvider } from "./scan/types.js";
import { arrayValue, objectValue, projectItem } from "./domain/projectors.js";
import { YifangyunClient } from "./client.js";

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export class YifangyunGateway {
  constructor(private readonly client: YifangyunClient, private readonly access: AccessRegistry, private readonly maxPageCapacity: number) {}

  context(id?: string): ResolvedAccess {
    return this.access.resolveContext(id);
  }

  getUser(pathname: string, contextId?: string, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<ApiJsonResponse> {
    const resolved = this.context(contextId);
    return this.client.getAsUser(pathname, resolved.context.userId, params, signal);
  }

  postUser(pathname: string, contextId: string | undefined, body: JsonValue, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<ApiJsonResponse> {
    const resolved = this.context(contextId);
    return this.client.postAsUser(pathname, resolved.context.userId, body, params, signal);
  }

  getEnterprise(pathname: string, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<ApiJsonResponse> {
    return this.client.getEnterprise(pathname, params, signal);
  }

  postEnterprise(pathname: string, body: JsonValue, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<ApiJsonResponse> {
    return this.client.postEnterprise(pathname, body, params, signal);
  }

  scanProvider(): ScopeScanProvider {
    return {
      getRoot: async (folderId: IdLike, userId?: IdLike, signal?: AbortSignal) => {
        const response = await this.client.getAsUser(`/v2/folder/${encodeURIComponent(String(folderId))}/info`, userId, {}, signal);
        return { folder: projectItem(response.data, "evidence"), meta: response.meta };
      },
      listChildren: async (folderId: IdLike, userId: IdLike | undefined, pageId: number, pageCapacity: number, signal?: AbortSignal) => {
        const response = await this.client.getAsUser(`/v2/folder/${encodeURIComponent(String(folderId))}/children`, userId, {
          type: "all",
          page_id: pageId,
          page_capacity: Math.min(pageCapacity, this.maxPageCapacity)
        }, signal);
        return this.toScanPage(response, pageId, pageCapacity);
      }
    };
  }

  private toScanPage(response: ApiJsonResponse, requestedPageId: number, requestedCapacity: number): ScopeScanPage {
    const source = objectValue(response.data) ?? {};
    const folders = arrayValue(source.folders).map((item) => projectItem(item, "evidence")).filter((item) => Object.keys(item).length > 0);
    const files = arrayValue(source.files).map((item) => projectItem(item, "evidence")).filter((item) => Object.keys(item).length > 0);
    const pageId = numberValue(source.page_id) ?? requestedPageId;
    const pageCapacity = numberValue(source.page_capacity) ?? requestedCapacity;
    const pageCount = numberValue(source.page_count);
    const totalCount = numberValue(source.total_count);
    const explicitHasMore = booleanValue(source.has_more);
    const pageCountHasMore = pageCount !== undefined ? pageId + 1 < pageCount : undefined;
    const totalCountHasMore = totalCount !== undefined ? (pageId + 1) * pageCapacity < totalCount : undefined;
    const derivedHasMore = pageCountHasMore ?? totalCountHasMore;
    const hasMore = explicitHasMore ?? derivedHasMore ?? false;
    const paginationSignals = [explicitHasMore, pageCountHasMore, totalCountHasMore].filter((value) => value !== undefined);
    const paginationReliable = paginationSignals.length > 0 && paginationSignals.every((value) => value === paginationSignals[0]);
    return {
      files,
      folders,
      hasMore,
      meta: response.meta,
      ...(hasMore ? { nextPageId: numberValue(source.next_page_id) ?? pageId + 1 } : {}),
      pageCapacity,
      ...(pageCount !== undefined ? { pageCount } : {}),
      pageId,
      paginationReliable,
      ...(totalCount !== undefined ? { totalCount } : {})
    };
  }
}
