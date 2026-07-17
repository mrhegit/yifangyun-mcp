import crypto from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { YifangyunError } from "../client.js";
import type { JsonObject } from "../types.js";
import type { ScopeItemCursor, ScopeItemPage, ScopePageArtifact, ScopePageReceipt, ScopeScanFrontier, ScopeScanRepository, ScopeScanState, ScopeSeenItem } from "./types.js";

type Row = Record<string, unknown>;
const SNAPSHOT_SCHEMA_VERSION = 2;

function normalizeText(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKC")
    .replace(/(^|\/)\s*\d+\s*[、.．]\s*/g, "$1")
    .replace(/[《》〈〉“”‘’（）()【】\[\]、，,。.;；:：_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("zh-CN");
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") {
    throw new Error("SQLite JSON column is not text.");
  }
  return JSON.parse(value) as T;
}

function jsonBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function itemDigest(item: JsonObject): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    depth: item.depth,
    id: item.id,
    modified_at_unix: item.modified_at_unix,
    name: item.name,
    parent_folder_id: item.parent_folder_id,
    path_display: item.path_display,
    size: item.size
  })).digest("hex");
}

function seenBytes(item: ScopeSeenItem): number {
  return jsonBytes(item.id) + jsonBytes(item.type) + jsonBytes(item.digest);
}

function frontierKey(cursor: ScopeScanFrontier): string {
  return `${cursor.folderId}:${cursor.pageId}`;
}

function frontierBytes(cursor: ScopeScanFrontier): number {
  return jsonBytes(JSON.stringify(cursor));
}

export class SqliteScopeScanStore implements ScopeScanRepository {
  private readonly database: DatabaseSync;
  private readonly locks = new Map<string, Promise<void>>();
  private lockHandle?: number;
  private lockPath?: string;
  private lockToken?: string;

  constructor(private readonly databasePath: string, private readonly ttlSeconds: number, private readonly maxBytes: number) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      try { chmodSync(path.dirname(databasePath), 0o700); } catch {}
      this.acquireProcessLock(databasePath);
    }
    try {
      this.database = new DatabaseSync(databasePath, { timeout: 5000 });
    } catch (error) {
      this.releaseProcessLock();
      throw error;
    }
    try {
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    this.assertSchemaVersion();
    if (databasePath !== ":memory:") {
      for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        try { chmodSync(filePath, 0o600); } catch {}
      }
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        scan_id TEXT PRIMARY KEY,
        access_identity_ref TEXT NOT NULL,
        root_folder_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        state_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS snapshots_reuse_idx ON snapshots(access_identity_ref, root_folder_id, policy_hash, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS snapshots_status_idx ON snapshots(status, expires_at_ms);
      CREATE TABLE IF NOT EXISTS snapshot_pages (
        scan_id TEXT NOT NULL REFERENCES snapshots(scan_id) ON DELETE CASCADE,
        page_key TEXT NOT NULL,
        folder_id TEXT NOT NULL DEFAULT '',
        commit_seq INTEGER NOT NULL DEFAULT 0,
        artifact_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (scan_id, page_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS snapshot_items (
        scan_id TEXT NOT NULL REFERENCES snapshots(scan_id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        page_key TEXT NOT NULL,
        name_normalized TEXT NOT NULL,
        path_normalized TEXT NOT NULL,
        sort_path TEXT NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (scan_id, item_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS snapshot_pages_commit_idx ON snapshot_pages(scan_id, commit_seq, page_key);
      CREATE INDEX IF NOT EXISTS snapshot_pages_folder_idx ON snapshot_pages(scan_id, folder_id);
      CREATE INDEX IF NOT EXISTS snapshot_items_sort_idx ON snapshot_items(scan_id, sort_path, item_id);
      CREATE INDEX IF NOT EXISTS snapshot_items_type_sort_idx ON snapshot_items(scan_id, item_type, sort_path, item_id);
      CREATE INDEX IF NOT EXISTS snapshot_items_page_idx ON snapshot_items(scan_id, page_key);
      CREATE VIRTUAL TABLE IF NOT EXISTS snapshot_items_fts USING fts5(
        scan_id UNINDEXED,
        item_id UNINDEXED,
        name_normalized,
        path_normalized,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS snapshot_items_fts_map (
        scan_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        fts_rowid INTEGER NOT NULL,
        PRIMARY KEY (scan_id, item_id)
      ) STRICT;
      DROP TRIGGER IF EXISTS snapshot_items_fts_insert;
      DROP TRIGGER IF EXISTS snapshot_items_fts_delete;
      CREATE TRIGGER IF NOT EXISTS snapshot_items_fts_insert AFTER INSERT ON snapshot_items BEGIN
        INSERT INTO snapshot_items_fts(scan_id, item_id, name_normalized, path_normalized)
        VALUES (new.scan_id, new.item_id, new.name_normalized, new.path_normalized);
        INSERT INTO snapshot_items_fts_map(scan_id, item_id, fts_rowid)
        VALUES (new.scan_id, new.item_id, last_insert_rowid());
      END;
      CREATE TRIGGER IF NOT EXISTS snapshot_items_fts_delete AFTER DELETE ON snapshot_items BEGIN
        DELETE FROM snapshot_items_fts WHERE rowid = (SELECT fts_rowid FROM snapshot_items_fts_map WHERE scan_id = old.scan_id AND item_id = old.item_id);
        DELETE FROM snapshot_items_fts_map WHERE scan_id = old.scan_id AND item_id = old.item_id;
      END;
      CREATE TABLE IF NOT EXISTS snapshot_frontier (
        scan_id TEXT NOT NULL REFERENCES snapshots(scan_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        cursor_key TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        folder_id TEXT NOT NULL,
        page_id INTEGER NOT NULL,
        path_display TEXT NOT NULL,
        PRIMARY KEY (scan_id, cursor_key),
        UNIQUE (scan_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS snapshot_frontier_fifo_idx ON snapshot_frontier(scan_id, sequence);
      CREATE TABLE IF NOT EXISTS snapshot_seen_items (
        scan_id TEXT NOT NULL REFERENCES snapshots(scan_id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_digest TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY (scan_id, item_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS snapshot_storage (
        scan_id TEXT PRIMARY KEY REFERENCES snapshots(scan_id) ON DELETE CASCADE,
        logical_bytes INTEGER NOT NULL
      ) STRICT;
    `);
    this.database.exec(`PRAGMA user_version=${SNAPSHOT_SCHEMA_VERSION}`);
    this.removeOrphanedFtsRows();
    } catch (error) {
      this.database.close();
      this.releaseProcessLock();
      throw error;
    }
  }

  close(): void {
    try {
      this.database.close();
    } finally {
      this.releaseProcessLock();
    }
  }

  async create(state: ScopeScanState, frontier: ScopeScanFrontier[]): Promise<void> {
    state.frontierCount = frontier.length;
    const stateJson = JSON.stringify(state);
    const bytes = jsonBytes(stateJson) + frontier.reduce((sum, cursor) => sum + frontierBytes(cursor), 0);
    this.assertCapacity(this.storageBytes() + bytes);
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO snapshots(scan_id, access_identity_ref, root_folder_id, policy_hash, status, expires_at_ms, updated_at_ms, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(state.scanId, state.accessIdentityRef, state.rootFolderId, state.policyHash, state.status, Date.parse(state.expiresAt), Date.parse(state.updatedAt), stateJson);
      const insertFrontier = this.database.prepare(`
        INSERT INTO snapshot_frontier(scan_id, sequence, cursor_key, attempt, depth, folder_id, page_id, path_display)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      frontier.forEach((cursor, sequence) => insertFrontier.run(state.scanId, sequence, frontierKey(cursor), cursor.attempt, cursor.depth, cursor.folderId, cursor.pageId, cursor.pathDisplay));
      this.database.prepare("INSERT INTO snapshot_storage(scan_id, logical_bytes) VALUES (?, ?)").run(state.scanId, bytes);
    });
  }

  async load(scanId: string): Promise<ScopeScanState> {
    const row = this.database.prepare("SELECT state_json FROM snapshots WHERE scan_id = ?").get(scanId) as Row | undefined;
    if (!row) {
      throw new YifangyunError("Snapshot was not found.", { code: "YFY_SNAPSHOT_NOT_FOUND", phase: "snapshot_store", scanId });
    }
    return parseJson<ScopeScanState>(row.state_json);
  }

  async save(state: ScopeScanState): Promise<void> {
    state.expiresAt = this.makeExpiry();
    const stateJson = JSON.stringify(state);
    const previous = this.database.prepare("SELECT state_json FROM snapshots WHERE scan_id = ?").get(state.scanId) as Row | undefined;
    const storage = this.scanStorage(state.scanId);
    const delta = jsonBytes(stateJson) - jsonBytes(String(previous?.state_json ?? ""));
    const projected = this.storageBytes() + delta;
    if (!["cancelled", "failed", "expired"].includes(state.status)) this.assertCapacity(projected);
    this.transaction(() => {
      this.updateState(state, stateJson);
      this.updateStorage(state.scanId, storage + delta);
    });
  }

  async commitPage(scanId: string, artifact: ScopePageArtifact, seenItems: ScopeSeenItem[], state: ScopeScanState, current: ScopeScanFrontier, append: ScopeScanFrontier[]): Promise<void> {
    state.expiresAt = this.makeExpiry();
    const artifactJson = JSON.stringify(artifact);
    const receiptJson = JSON.stringify(artifact.receipt);
    const itemJson = [...artifact.folders, ...artifact.files].map((item) => JSON.stringify(item));
    const previousState = this.database.prepare("SELECT state_json FROM snapshots WHERE scan_id = ?").get(scanId) as Row | undefined;
    const previousPage = this.database.prepare("SELECT artifact_json, receipt_json FROM snapshot_pages WHERE scan_id = ? AND page_key = ?").get(scanId, artifact.pageKey) as Row | undefined;
    const previousItems = this.database.prepare("SELECT item_json FROM snapshot_items WHERE scan_id = ? AND page_key = ?").all(scanId, artifact.pageKey) as Row[];
    const existingSeen = await this.findSeenItems(scanId, seenItems.map((item) => item.id));
    const newSeen = seenItems.filter((item) => !existingSeen.has(item.id));
    const previousBytes = jsonBytes(String(previousState?.state_json ?? ""))
      + (previousPage ? jsonBytes(String(previousPage.artifact_json)) + jsonBytes(String(previousPage.receipt_json)) : 0)
      + previousItems.reduce((sum, row) => sum + jsonBytes(String(row.item_json)), 0);
    const serializedGrowth = jsonBytes(JSON.stringify(state)) + jsonBytes(artifactJson) + jsonBytes(receiptJson)
      + itemJson.reduce((sum, value) => sum + jsonBytes(value), 0)
      + newSeen.reduce((sum, item) => sum + seenBytes(item), 0)
      + append.reduce((sum, cursor) => sum + frontierBytes(cursor), 0);
    const walGrowthReservation = 1_048_576 + serializedGrowth * 8;
    this.assertCapacity(this.storageBytes() + walGrowthReservation);
    this.transaction(() => {
      let frontierDelta = 0;
      const removed = this.database.prepare("DELETE FROM snapshot_frontier WHERE scan_id = ? AND cursor_key = ?").run(scanId, frontierKey(current));
      if (Number(removed.changes) === 1) frontierDelta -= frontierBytes(current);
      const maxSequence = Number((this.database.prepare("SELECT coalesce(max(sequence), -1) AS value FROM snapshot_frontier WHERE scan_id = ?").get(scanId) as Row).value ?? -1);
      const insertFrontier = this.database.prepare(`
        INSERT OR IGNORE INTO snapshot_frontier(scan_id, sequence, cursor_key, attempt, depth, folder_id, page_id, path_display)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let nextSequence = maxSequence + 1;
      let insertedFrontier = 0;
      for (const cursor of append) {
        const inserted = insertFrontier.run(scanId, nextSequence, frontierKey(cursor), cursor.attempt, cursor.depth, cursor.folderId, cursor.pageId, cursor.pathDisplay);
        if (Number(inserted.changes) === 1) {
          frontierDelta += frontierBytes(cursor);
          nextSequence += 1;
          insertedFrontier += 1;
        }
      }
      state.frontierCount = Math.max(0, state.frontierCount - Number(removed.changes) + insertedFrontier);
      const stateJson = JSON.stringify(state);
      const incomingBytes = jsonBytes(stateJson) + jsonBytes(artifactJson) + jsonBytes(receiptJson)
        + itemJson.reduce((sum, value) => sum + jsonBytes(value), 0)
        + newSeen.reduce((sum, item) => sum + seenBytes(item), 0);
      const delta = incomingBytes - previousBytes + frontierDelta;
      this.assertCapacity(this.storageBytes() + delta);
      this.database.prepare(`
        INSERT INTO snapshot_pages(scan_id, page_key, folder_id, commit_seq, artifact_json, receipt_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id, page_key) DO UPDATE SET folder_id=excluded.folder_id, commit_seq=excluded.commit_seq, artifact_json=excluded.artifact_json, receipt_json=excluded.receipt_json
      `).run(scanId, artifact.pageKey, artifact.receipt.folderId, state.pageReceiptCount, artifactJson, receiptJson);
      this.database.prepare("DELETE FROM snapshot_items WHERE scan_id = ? AND page_key = ?").run(scanId, artifact.pageKey);
      const insertItem = this.database.prepare(`
        INSERT INTO snapshot_items(scan_id, item_id, item_type, page_key, name_normalized, path_normalized, sort_path, item_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of [...artifact.folders, ...artifact.files]) {
        const itemId = String(item.id ?? "");
        const itemType = String(item.type ?? "");
        if (!itemId || (itemType !== "file" && itemType !== "folder")) {
          continue;
        }
        const itemPath = String(item.path_display ?? "");
        insertItem.run(
          scanId,
          `${itemType}:${itemId}`,
          itemType,
          artifact.pageKey,
          normalizeText(String(item.name ?? ""), state.policy.caseSensitive),
          normalizeText(itemPath, state.policy.caseSensitive),
          itemPath,
          JSON.stringify(item)
        );
      }
      const insertSeen = this.database.prepare(`
        INSERT OR IGNORE INTO snapshot_seen_items(scan_id, item_id, item_type, item_digest, byte_size)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const item of newSeen) {
        insertSeen.run(scanId, item.id, item.type, item.digest, seenBytes(item));
      }
      this.updateState(state, stateJson);
      this.updateStorage(scanId, this.scanStorage(scanId) + delta);
      this.assertCapacity(this.storageBytes());
    });
  }

  async peekFrontier(scanId: string, limit: number): Promise<ScopeScanFrontier[]> {
    const rows = this.database.prepare(`
      SELECT attempt, depth, folder_id, page_id, path_display
      FROM snapshot_frontier WHERE scan_id = ? ORDER BY sequence LIMIT ?
    `).all(scanId, limit) as Row[];
    return rows.map((row) => ({ attempt: Number(row.attempt), depth: Number(row.depth), folderId: String(row.folder_id), pageId: Number(row.page_id), pathDisplay: String(row.path_display) }));
  }

  async updateFrontier(scanId: string, cursor: ScopeScanFrontier): Promise<void> {
    const result = this.database.prepare("UPDATE snapshot_frontier SET attempt = ? WHERE scan_id = ? AND cursor_key = ?").run(cursor.attempt, scanId, frontierKey(cursor));
    if (Number(result.changes) !== 1) throw new YifangyunError("Snapshot frontier cursor was not found.", { code: "YFY_SNAPSHOT_FRONTIER_CONFLICT", phase: "snapshot_store", scanId });
  }

  async removeFrontier(scanId: string, cursor: ScopeScanFrontier, state: ScopeScanState): Promise<void> {
    state.expiresAt = this.makeExpiry();
    this.transaction(() => {
      const previous = this.database.prepare("SELECT state_json FROM snapshots WHERE scan_id = ?").get(scanId) as Row;
      const storage = this.scanStorage(scanId);
      const removed = this.database.prepare("DELETE FROM snapshot_frontier WHERE scan_id = ? AND cursor_key = ?").run(scanId, frontierKey(cursor));
      if (Number(removed.changes) !== 1) throw new YifangyunError("Snapshot frontier cursor was not found.", { code: "YFY_SNAPSHOT_FRONTIER_CONFLICT", phase: "snapshot_store", scanId });
      state.frontierCount = Math.max(0, state.frontierCount - 1);
      const stateJson = JSON.stringify(state);
      const delta = jsonBytes(stateJson) - jsonBytes(String(previous.state_json)) - frontierBytes(cursor);
      this.updateState(state, stateJson);
      this.updateStorage(scanId, storage + delta);
    });
  }

  async findSeenItems(scanId: string, itemIds: string[]): Promise<Map<string, ScopeSeenItem>> {
    if (itemIds.length === 0) return new Map();
    const unique = [...new Set(itemIds)];
    const rows = this.database.prepare(`
      SELECT item_id, item_type, item_digest FROM snapshot_seen_items
      WHERE scan_id = ? AND item_id IN (${unique.map(() => "?").join(",")})
    `).all(scanId, ...unique) as Row[];
    return new Map(rows.map((row) => [String(row.item_id), {
      digest: String(row.item_digest),
      id: String(row.item_id),
      type: String(row.item_type) as "file" | "folder"
    }]));
  }

  async observedItemCount(scanId: string, folderId: string): Promise<number> {
    const row = this.database.prepare(`
      SELECT coalesce(sum(CAST(json_extract(receipt_json, '$.itemCount') AS INTEGER)), 0) AS total
      FROM snapshot_pages WHERE scan_id = ? AND folder_id = ?
    `).get(scanId, folderId) as Row;
    return Number(row.total ?? 0);
  }

  async hasPage(scanId: string, pageKey: string): Promise<boolean> {
    return Boolean(this.database.prepare("SELECT 1 AS found FROM snapshot_pages WHERE scan_id = ? AND page_key = ?").get(scanId, pageKey));
  }

  async listPages(scanId: string): Promise<ScopePageArtifact[]> {
    const rows = this.database.prepare("SELECT artifact_json FROM snapshot_pages WHERE scan_id = ? ORDER BY commit_seq, page_key").all(scanId) as Row[];
    return rows.map((row) => parseJson<ScopePageArtifact>(row.artifact_json));
  }

  async listReceiptSummary(scanId: string, limit: number): Promise<{ receipts: ScopePageReceipt[]; total: number }> {
    const totalRow = this.database.prepare("SELECT count(*) AS total FROM snapshot_pages WHERE scan_id = ?").get(scanId) as Row;
    const rows = this.database.prepare("SELECT receipt_json FROM snapshot_pages WHERE scan_id = ? ORDER BY commit_seq, page_key LIMIT ?").all(scanId, limit) as Row[];
    return { receipts: rows.map((row) => parseJson<ScopePageReceipt>(row.receipt_json)), total: Number(totalRow.total) };
  }

  async findReusable(accessIdentityRef: string, rootFolderId: string, policyHash: string): Promise<ScopeScanState | undefined> {
    const row = this.database.prepare(`
      SELECT state_json FROM snapshots
      WHERE access_identity_ref = ? AND root_folder_id = ? AND policy_hash = ?
        AND status NOT IN ('cancelled', 'failed', 'expired') AND expires_at_ms > ?
      ORDER BY updated_at_ms DESC LIMIT 1
    `).get(accessIdentityRef, rootFolderId, policyHash, Date.now()) as Row | undefined;
    return row ? parseJson<ScopeScanState>(row.state_json) : undefined;
  }

  async pruneExpired(): Promise<void> {
    const result = this.database.prepare("DELETE FROM snapshots WHERE expires_at_ms <= ?").run(Date.now());
    if (Number(result.changes) > 0) this.database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;");
  }

  async listRunnable(): Promise<ScopeScanState[]> {
    const rows = this.database.prepare(`
      SELECT state_json FROM snapshots
      WHERE status IN ('running', 'paused_retryable') AND expires_at_ms > ?
      ORDER BY updated_at_ms
    `).all(Date.now()) as Row[];
    return rows.map((row) => parseJson<ScopeScanState>(row.state_json));
  }

  async searchItems(
    scanId: string,
    queries: Array<{ normalized: string; original: string }>,
    matchFields: Array<"name" | "path">,
    type: "file" | "folder" | "all",
    cursor: ScopeItemCursor | undefined,
    limit: number,
    caseSensitive: boolean
  ): Promise<ScopeItemPage> {
    if (queries.length === 0) {
      return { items: [], total: 0 };
    }
    const useFts = !caseSensitive && queries.every((query) => Array.from(query.normalized).length >= 3);
    let from: string;
    let where: string;
    let parameters: Array<string | number>;
    if (useFts) {
      const expression = queries.map((query) => {
        const phrase = `"${query.normalized.replace(/"/g, '""')}"`;
        const fields = [
          ...(matchFields.includes("name") ? [`name_normalized : ${phrase}`] : []),
          ...(matchFields.includes("path") ? [`path_normalized : ${phrase}`] : [])
        ];
        return `(${fields.join(" OR ")})`;
      }).join(" OR ");
      from = "snapshot_items i JOIN snapshot_items_fts ON snapshot_items_fts.scan_id = i.scan_id AND snapshot_items_fts.item_id = i.item_id";
      where = "i.scan_id = ? AND snapshot_items_fts MATCH ?";
      parameters = [scanId, expression];
    } else {
      const clauses: string[] = [];
      parameters = [scanId];
      for (const query of queries) {
        const fields: string[] = [];
        if (matchFields.includes("name")) {
          fields.push("instr(i.name_normalized, ?) > 0");
          parameters.push(query.normalized);
        }
        if (matchFields.includes("path")) {
          fields.push("instr(i.path_normalized, ?) > 0");
          parameters.push(query.normalized);
        }
        clauses.push(`(${fields.join(" OR ")})`);
      }
      from = "snapshot_items i";
      where = `i.scan_id = ? AND (${clauses.join(" OR ")})`;
    }
    if (type !== "all") {
      where += " AND i.item_type = ?";
      parameters.push(type);
    }
    const total = cursor?.total ?? Number((this.database.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${where}`).get(...parameters) as Row).total ?? 0);
    const cursorClause = cursor ? " AND (i.sort_path, i.item_id) > (?, ?)" : "";
    const cursorParameters = cursor ? [cursor.sortPath, cursor.itemId] : [];
    const rows = this.database.prepare(`SELECT i.item_id, i.item_json, i.name_normalized, i.path_normalized, i.sort_path FROM ${from} WHERE ${where}${cursorClause} ORDER BY i.sort_path, i.item_id LIMIT ?`)
      .all(...parameters, ...cursorParameters, limit + 1) as Row[];
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => {
      const item = parseJson<JsonObject>(row.item_json);
      const name = String(row.name_normalized ?? "");
      const itemPath = String(row.path_normalized ?? "");
      const matched = queries.filter((query) => (matchFields.includes("name") && name.includes(query.normalized)) || (matchFields.includes("path") && itemPath.includes(query.normalized))).map((query) => query.original);
      return { ...item, matched_queries: matched };
    });
    const last = pageRows.at(-1);
    return {
      items,
      ...(rows.length > limit && last ? { nextCursor: { itemId: String(last.item_id), revision: cursor?.revision ?? 0, sortPath: String(last.sort_path), total } } : {}),
      total
    };
  }

  async listItems(scanId: string, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number): Promise<ScopeItemPage> {
    const typeClause = type === "all" ? "" : " AND item_type = ?";
    const parameters: Array<string | number> = type === "all" ? [scanId] : [scanId, type];
    const total = cursor?.total ?? Number((this.database.prepare(`SELECT count(*) AS total FROM snapshot_items WHERE scan_id = ?${typeClause}`).get(...parameters) as Row).total ?? 0);
    const cursorClause = cursor ? " AND (sort_path, item_id) > (?, ?)" : "";
    const cursorParameters = cursor ? [cursor.sortPath, cursor.itemId] : [];
    const rows = this.database.prepare(`SELECT item_id, item_json, sort_path FROM snapshot_items WHERE scan_id = ?${typeClause}${cursorClause} ORDER BY sort_path, item_id LIMIT ?`)
      .all(...parameters, ...cursorParameters, limit + 1) as Row[];
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => parseJson<JsonObject>(row.item_json)),
      ...(rows.length > limit && last ? { nextCursor: { itemId: String(last.item_id), revision: cursor?.revision ?? 0, sortPath: String(last.sort_path), total } } : {}),
      total
    };
  }

  async withLock<T>(scanId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scanId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(scanId, chain);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(scanId) === chain) {
        this.locks.delete(scanId);
      }
    }
  }

  makeExpiry(now = Date.now()): string {
    return new Date(now + this.ttlSeconds * 1000).toISOString();
  }

  storageBytes(): number {
    const row = this.database.prepare("SELECT coalesce(sum(logical_bytes), 0) AS bytes FROM snapshot_storage").get() as Row;
    const logicalBytes = Number(row.bytes ?? 0);
    if (this.databasePath === ":memory:") return logicalBytes;
    const pageCount = Number((this.database.prepare("PRAGMA page_count").get() as Row).page_count ?? 0);
    const freePages = Number((this.database.prepare("PRAGMA freelist_count").get() as Row).freelist_count ?? 0);
    const pageSize = Number((this.database.prepare("PRAGMA page_size").get() as Row).page_size ?? 0);
    let physicalBytes = Math.max(0, pageCount - freePages) * pageSize;
    try { physicalBytes += statSync(`${this.databasePath}-wal`).size; } catch {}
    return Math.max(logicalBytes, physicalBytes);
  }

  private updateState(state: ScopeScanState, stateJson: string): void {
    const result = this.database.prepare(`
      UPDATE snapshots SET status = ?, expires_at_ms = ?, updated_at_ms = ?, state_json = ? WHERE scan_id = ?
    `).run(state.status, Date.parse(state.expiresAt), Date.parse(state.updatedAt), stateJson, state.scanId);
    if (Number(result.changes) !== 1) {
      throw new YifangyunError("Snapshot state disappeared during update.", { code: "YFY_SNAPSHOT_NOT_FOUND", phase: "snapshot_store", scanId: state.scanId });
    }
  }

  private transaction(work: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
        try { this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      }
      throw error;
    }
  }

  private assertSchemaVersion(): void {
    const versionRow = this.database.prepare("PRAGMA user_version").get() as Row;
    const version = Number(versionRow.user_version ?? 0);
    const hasSnapshotSchema = Boolean(this.database.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type IN ('table', 'view') AND name LIKE 'snapshot%'
      LIMIT 1
    `).get());
    if ((hasSnapshotSchema && version !== SNAPSHOT_SCHEMA_VERSION) || (!hasSnapshotSchema && version !== 0 && version !== SNAPSHOT_SCHEMA_VERSION)) {
      throw new YifangyunError("Snapshot database schema is incompatible with this server version.", {
        code: "YFY_STATE_SCHEMA_MISMATCH",
        details: { actual_schema_version: version, expected_schema_version: SNAPSHOT_SCHEMA_VERSION },
        phase: "snapshot_store",
        suggestedAction: "Configure a new YFY_STATE_DB path or remove the old database after confirming its snapshots are no longer needed."
      });
    }
  }

  private acquireProcessLock(databasePath: string): void {
    const lockPath = `${databasePath}.lock`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = openSync(lockPath, "wx", 0o600);
        const token = crypto.randomUUID();
        writeFileSync(handle, JSON.stringify({ created_at_ms: Date.now(), pid: process.pid, token }), "utf8");
        fsyncSync(handle);
        this.lockHandle = handle;
        this.lockPath = lockPath;
        this.lockToken = token;
        return;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST") throw error;
        let observed: string;
        let ageMs: number;
        try {
          observed = readFileSync(lockPath, "utf8");
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch (readError) {
          const readCode = readError instanceof Error && "code" in readError ? String(readError.code) : "";
          if (readCode === "ENOENT") continue;
          throw readError;
        }
        let ownerPid = 0;
        try {
          const owner = JSON.parse(observed) as { pid?: unknown };
          ownerPid = typeof owner.pid === "number" ? owner.pid : 0;
        } catch {}
        let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
        if (ownerAlive) {
          try { process.kill(ownerPid, 0); } catch (probeError) {
            ownerAlive = probeError instanceof Error && "code" in probeError && probeError.code === "EPERM";
          }
        }
        if (ownerAlive || ageMs < 5000 || attempt > 1) {
          throw new YifangyunError("Snapshot database is already open by another process.", { code: "YFY_STATE_DB_IN_USE", phase: "snapshot_store" });
        }
        const stalePath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale`;
        try {
          renameSync(lockPath, stalePath);
        } catch (renameError) {
          const renameCode = renameError instanceof Error && "code" in renameError ? String(renameError.code) : "";
          if (renameCode === "ENOENT") continue;
          throw renameError;
        }
        const moved = readFileSync(stalePath, "utf8");
        if (moved !== observed) {
          if (!existsSync(lockPath)) renameSync(stalePath, lockPath);
          throw new YifangyunError("Snapshot database lock ownership changed during recovery.", { code: "YFY_STATE_DB_IN_USE", phase: "snapshot_store" });
        }
        rmSync(stalePath, { force: true });
      }
    }
    throw new YifangyunError("Snapshot database lock could not be acquired.", { code: "YFY_STATE_DB_IN_USE", phase: "snapshot_store" });
  }

  private releaseProcessLock(): void {
    if (this.lockHandle !== undefined) {
      try { closeSync(this.lockHandle); } catch {}
      this.lockHandle = undefined;
    }
    if (this.lockPath && this.lockToken) {
      const lockPath = this.lockPath;
      const token = this.lockToken;
      try {
        const observed = readFileSync(lockPath, "utf8");
        const owner = JSON.parse(observed) as { token?: unknown };
        if (owner.token === token) {
          const releasePath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.release`;
          renameSync(lockPath, releasePath);
          const moved = JSON.parse(readFileSync(releasePath, "utf8")) as { token?: unknown };
          if (moved.token === token) {
            rmSync(releasePath, { force: true });
          } else if (!existsSync(lockPath)) {
            renameSync(releasePath, lockPath);
          }
        }
      } catch {}
    }
    this.lockPath = undefined;
    this.lockToken = undefined;
  }

  private removeOrphanedFtsRows(): void {
    this.database.prepare(`
      DELETE FROM snapshot_items_fts
      WHERE rowid NOT IN (SELECT fts_rowid FROM snapshot_items_fts_map)
    `).run();
    this.database.prepare(`
      DELETE FROM snapshot_items_fts_map
      WHERE NOT EXISTS (
        SELECT 1 FROM snapshot_items i
        WHERE i.scan_id = snapshot_items_fts_map.scan_id AND i.item_id = snapshot_items_fts_map.item_id
      )
    `).run();
  }

  private scanStorage(scanId: string): number {
    const row = this.database.prepare("SELECT logical_bytes FROM snapshot_storage WHERE scan_id = ?").get(scanId) as Row | undefined;
    if (!row) {
      throw new YifangyunError("Snapshot storage accounting is missing.", { code: "YFY_SNAPSHOT_STORAGE_CORRUPT", phase: "snapshot_store", scanId });
    }
    return Number(row.logical_bytes);
  }

  private updateStorage(scanId: string, bytes: number): void {
    this.database.prepare("UPDATE snapshot_storage SET logical_bytes = ? WHERE scan_id = ?").run(bytes, scanId);
  }

  private assertCapacity(projectedBytes: number): void {
    if (projectedBytes > this.maxBytes) {
      throw new YifangyunError("Snapshot storage quota would be exceeded.", {
        code: "YFY_SNAPSHOT_STORAGE_INSUFFICIENT",
        details: { max_state_bytes: this.maxBytes, projected_bytes: projectedBytes },
        phase: "snapshot_store"
      });
    }
  }
}
