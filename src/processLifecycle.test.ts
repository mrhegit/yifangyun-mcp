import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entryPath = fileURLToPath(new URL("./index.js", import.meta.url));

function startServer(root: string) {
  const child = spawn(process.execPath, [entryPath], {
    env: {
      ...process.env,
      YFY_CLIENT_ID: "lifecycle-test",
      YFY_CLIENT_SECRET: "lifecycle-test",
      YFY_DEFAULT_USER_ID: "1",
      YFY_ENTERPRISE_ID: "1",
      YFY_LOG_LEVEL: "info",
      YFY_STATE_DB: path.join(root, "state.sqlite"),
      YFY_TEMP_DIR: root,
      YFY_TOOLSETS: "drive",
      YFY_TRANSPORT: "stdio"
    },
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

async function waitForLog(server: ReturnType<typeof startServer>, event: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const marker = `"event":"${event}"`;
  while (Date.now() < deadline) {
    if (server.stderr().includes(marker)) return;
    if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`Server exited before ${event}: ${server.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${event}: ${server.stderr()}`);
}

async function waitForExit(server: ReturnType<typeof startServer>, timeoutMs = 3000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return { code: server.child.exitCode, signal: server.child.signalCode };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(server.child, "exit").then(([code, signal]) => ({
        code: code as number | null,
        signal: signal as NodeJS.Signals | null
      })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Server did not exit after stdio closed: ${server.stderr()}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function forceStop(server: ReturnType<typeof startServer> | undefined): Promise<void> {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill();
  await waitForExit(server, 1000).catch(() => undefined);
}

test("stdio server exits and releases its runtime when the host closes stdin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-stdio-lifecycle-"));
  let first: ReturnType<typeof startServer> | undefined;
  let second: ReturnType<typeof startServer> | undefined;
  try {
    first = startServer(root);
    await waitForLog(first, "server_started");
    first.child.stdin.end();
    assert.deepEqual(await waitForExit(first), { code: 0, signal: null });
    assert.match(first.stderr(), /"event":"server_stopping"/);
    assert.match(first.stderr(), /"signal":"STDIN_(?:END|CLOSE|CLOSED)"/);
    assert.equal(first.stderr().match(/"event":"server_stopping"/g)?.length, 1);

    second = startServer(root);
    await waitForLog(second, "server_started");
    second.child.stdin.end();
    assert.deepEqual(await waitForExit(second), { code: 0, signal: null });
  } finally {
    await forceStop(second);
    await forceStop(first);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("stdio server exits when stdin is already closing during startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-stdio-startup-close-"));
  const server = startServer(root);
  try {
    server.child.stdin.end();
    assert.deepEqual(await waitForExit(server), { code: 0, signal: null });
    assert.match(server.stderr(), /"signal":"STDIN_(?:END|CLOSE|CLOSED)"/);
    assert.equal(server.stderr().match(/"event":"server_stopping"/g)?.length, 1);
  } finally {
    await forceStop(server);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
