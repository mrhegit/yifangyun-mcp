import crypto from "node:crypto";
import { configFingerprint } from "../capabilities.js";
import { AccessRegistry } from "./access.js";
import type { AppConfig } from "../types.js";
import { YifangyunClient, YifangyunError } from "../client.js";
import { YifangyunGateway } from "../gateway.js";
import { ScopeScanEngine } from "../scan/engine.js";
import { SnapshotService } from "../scan/service.js";
import { SqliteScopeScanStore } from "../scan/store.js";
import { EvidenceArtifactRegistry } from "./evidence.js";

export class AppRuntime {
  readonly access: AccessRegistry;
  readonly client: YifangyunClient;
  readonly evidence: EvidenceArtifactRegistry;
  readonly gateway: YifangyunGateway;
  readonly snapshots: SnapshotService;
  readonly configFingerprint: string;
  readonly instanceId = crypto.randomUUID();
  readonly startedAtIso = new Date().toISOString();

  private constructor(readonly config: AppConfig, repository: SqliteScopeScanStore) {
    this.access = new AccessRegistry(config);
    this.configFingerprint = configFingerprint(config);
    this.client = new YifangyunClient(config);
    this.evidence = new EvidenceArtifactRegistry(config.tempFileTtlSeconds, config.maxEvidenceResourceBytes ?? 16777216);
    this.gateway = new YifangyunGateway(this.client, this.access, config.maxPageCapacity);
    const engine = new ScopeScanEngine(repository, this.gateway.scanProvider());
    this.snapshots = new SnapshotService(engine, repository, this.access, config.snapshotConcurrency ?? 2);
  }

  static async create(config: AppConfig): Promise<AppRuntime> {
    const repository = new SqliteScopeScanStore(
      config.stateDatabasePath,
      config.snapshotTtlSeconds ?? 604800,
      config.maxStateBytes ?? 2147483648
    );
    const runtime = new AppRuntime(config, repository);
    try {
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
    try { await this.evidence.close(); } catch { failures.push("evidence"); }
    try { await this.client.close(); } catch { failures.push("client"); }
    if (failures.length > 0) {
      throw new YifangyunError("Runtime cleanup did not complete.", { code: "YFY_RUNTIME_CLEANUP_FAILED", phase: "runtime_shutdown", details: { failed_components: failures } });
    }
  }
}
