import crypto from "node:crypto";
import { configFingerprint } from "../capabilities.js";
import type { AppConfig } from "../types.js";
import { YifangyunClient, YifangyunError } from "../client.js";
import { YifangyunGateway } from "../gateway.js";
import { ScopeScanEngine } from "../scan/engine.js";
import { SnapshotService } from "../scan/service.js";
import type { ScopeScanRepository } from "../scan/types.js";
import { WorkerScopeScanStore } from "../scan/workerStore.js";
import { AccessRegistry } from "./access.js";
import { DownloadRegistry } from "./downloads.js";
import { TempStorageManager } from "./tempStorage.js";

export class AppRuntime {
  readonly access: AccessRegistry;
  readonly client: YifangyunClient;
  readonly downloads: DownloadRegistry;
  readonly gateway: YifangyunGateway;
  readonly snapshots: SnapshotService;
  readonly tempStorage: TempStorageManager;
  readonly configFingerprint: string;
  readonly instanceId = crypto.randomUUID();
  readonly startedAtIso = new Date().toISOString();

  private constructor(readonly config: AppConfig, repository: ScopeScanRepository) {
    this.access = new AccessRegistry(config);
    this.configFingerprint = configFingerprint(config);
    this.tempStorage = new TempStorageManager(config.tempDir, config.maxTempBytes ?? 1_073_741_824, config.tempFileTtlSeconds);
    this.client = new YifangyunClient(config, undefined, this.tempStorage);
    this.downloads = new DownloadRegistry(
      this.tempStorage,
      config.tempFileTtlSeconds,
      config.downloadStagedMaxFetches ?? 10,
      10_000,
      config.downloadStagedMaxConcurrentReads ?? 20
    );
    this.gateway = new YifangyunGateway(this.client, this.access, config.maxPageCapacity);
    const engine = new ScopeScanEngine(repository, this.gateway.scanProvider());
    this.snapshots = new SnapshotService(engine, repository, this.access, config.snapshotConcurrency ?? 2);
  }

  static async create(config: AppConfig): Promise<AppRuntime> {
    const repository = await WorkerScopeScanStore.create(
      config.stateDatabasePath,
      config.snapshotTtlSeconds ?? 604800,
      config.maxStateBytes ?? 2147483648
    );
    const runtime = new AppRuntime(config, repository);
    try {
      await runtime.downloads.initialize();
      await runtime.snapshots.initialize();
      return runtime;
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const failures: string[] = [];
    try { await this.snapshots.close(); } catch { failures.push("snapshots"); }
    try { await this.downloads.close(); } catch { failures.push("downloads"); }
    try { await this.client.close(); } catch { failures.push("client"); }
    if (failures.length > 0) {
      throw new YifangyunError("Runtime cleanup did not complete.", { code: "YFY_RUNTIME_CLEANUP_FAILED", phase: "runtime_shutdown", details: { failed_components: failures } });
    }
  }
}
