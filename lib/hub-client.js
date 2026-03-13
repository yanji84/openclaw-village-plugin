import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatUptime, sleep } from "./helpers.js";

export function createHubClient(ctx, { startPolling, stopPolling }) {
  const { api } = ctx;

  function getState() {
    if (!ctx.remoteState.running) return "OFFLINE";
    if (!ctx.remoteState.hubConnected) return "CONNECTING";
    if (ctx.remoteState.botName) return "IN_GAME";
    return "CONNECTED";
  }

  function applyRemoteConfig(cfg) {
    if (!cfg) return;
    if (cfg.pollTimeoutMs) ctx.POLL_TIMEOUT_MS = cfg.pollTimeoutMs;
    if (cfg.backoffMs) ctx.BACKOFF_MS = cfg.backoffMs;
  }

  function getAvgSceneMs() {
    return ctx.metrics.scenesProcessed > 0
      ? Math.round(ctx.metrics.sceneTotalMs / ctx.metrics.scenesProcessed)
      : null;
  }

  async function hubRequest(method, path, body, timeoutMs = 15_000) {
    if (!ctx.VILLAGE_HUB || !ctx.VILLAGE_TOKEN) {
      throw new Error("VILLAGE_HUB/VILLAGE_TOKEN not configured");
    }
    const url = `${ctx.VILLAGE_HUB}${path}`;
    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${ctx.VILLAGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    let data;
    try { data = await resp.json(); } catch { data = await resp.text().catch(() => ""); }
    return { status: resp.status, data };
  }

  async function joinVillage() {
    api.logger.info(`village: joining remote village at ${ctx.VILLAGE_HUB}`);

    // Hello handshake
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { status, data } = await hubRequest("POST", "/api/village/heartbeat", { ...buildHeartbeat(), isHello: true });
        if (status === 200) {
          ctx.remoteState.running = true;
          ctx.remoteState.hubConnected = true;
          api.logger.info(`[village] state: OFFLINE → CONNECTED (hub: ${ctx.VILLAGE_HUB})`);

          backgroundLoop().catch((err) => {
            api.logger.warn(`village: background loop ended: ${err.message}`);
          });

          break;
        }
        throw new Error(data?.error || `hello failed (${status})`);
      } catch (err) {
        api.logger.warn(`village: hub unreachable (attempt ${attempt + 1}/3): ${err.message}`);
        if (attempt < 2) {
          await sleep(5_000);
        } else {
          throw new Error("hub unreachable after 3 attempts");
        }
      }
    }

    // Join the game
    for (let attempt = 0; attempt < 3; attempt++) {
      const { status, data } = await hubRequest("POST", "/api/village/join", {});
      if (status >= 400 && status !== 409) {
        throw new Error(data?.error || `join failed (${status})`);
      }
      if (data?.botName) {
        ctx.remoteState.botName = data.botName;
        applyRemoteConfig(data.config);
        break;
      }
      api.logger.warn(`village: join response missing botName (attempt ${attempt + 1}), retrying`);
      await sleep(2_000);
    }
    if (!ctx.remoteState.botName) {
      throw new Error("join response never included botName");
    }
    startPolling();
    api.logger.info(`[village] state: CONNECTED → IN_GAME (bot: ${ctx.remoteState.botName})`);
  }

  async function leaveVillage() {
    stopPolling();
    ctx.remoteState.running = false;
    ctx.remoteState.hubConnected = false;
    await hubRequest("POST", "/api/village/leave", {}).catch(() => {});
    ctx.remoteState.botName = null;
    api.logger.info("[village] state: IN_GAME → OFFLINE (leave request)");
  }

  function buildHeartbeat() {
    const uptimeMs = Date.now() - ctx.metrics.activatedAt;

    let memoryFileCount = null;
    try {
      memoryFileCount = readdirSync(join(ctx.workspaceDir, "memory")).length;
    } catch {}

    let sessionCount = null;
    let sessionSizeBytes = null;
    try {
      const sessDir = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".openclaw", "agents", "main", "sessions");
      const files = readdirSync(sessDir).filter(f => f.endsWith(".jsonl"));
      sessionCount = files.length;
      sessionSizeBytes = files.reduce((sum, f) => {
        try { return sum + statSync(join(sessDir, f)).size; } catch { return sum; }
      }, 0);
    } catch {}

    return {
      version: ctx.pluginVersion,
      instanceId: ctx.instanceId,
      uptimeMs,
      joined: !!ctx.remoteState.botName,
      heartbeatIntervalMs: 60_000,
      scenesProcessed: ctx.metrics.scenesProcessed,
      scenesFailed: ctx.metrics.scenesFailed,
      avgSceneMs: getAvgSceneMs(),
      lastSceneAt: ctx.metrics.lastSceneAt,
      pollErrors: ctx.metrics.pollErrors,
      memoryFileCount,
      sessionCount,
      sessionSizeBytes,
    };
  }

  // Combined heartbeat + health log loop (single 60s cadence)
  async function backgroundLoop() {
    while (ctx.remoteState.running) {
      await sleep(60_000);
      if (!ctx.remoteState.running) break;

      // Heartbeat
      try {
        const { data: hbResp } = await hubRequest("POST", "/api/village/heartbeat", buildHeartbeat());
        ctx.metrics.lastHeartbeatAt = Date.now();
        applyRemoteConfig(hbResp?.config);
      } catch (err) {
        api.logger.warn(`village: heartbeat failed: ${err.message}`);
      }

      // Health log
      const state = getState();
      const uptime = formatUptime(Date.now() - ctx.metrics.activatedAt);
      if (state === "IN_GAME") {
        const avgMs = getAvgSceneMs();
        api.logger.info(`[village] health: state=IN_GAME scenes=${ctx.metrics.scenesProcessed} errors=${ctx.metrics.pollErrors} avgScene=${avgMs != null ? `${avgMs}ms` : "-"} uptime=${uptime}`);
      } else if (state === "CONNECTED") {
        const ago = ctx.metrics.lastHeartbeatAt
          ? `${Math.round((Date.now() - ctx.metrics.lastHeartbeatAt) / 1000)}s ago`
          : "never";
        api.logger.info(`[village] health: state=CONNECTED hub=ok lastHeartbeat=${ago} uptime=${uptime}`);
      } else {
        api.logger.info(`[village] health: state=${state} hub=UNREACHABLE uptime=${uptime}`);
      }
    }
  }

  return { hubRequest, joinVillage, leaveVillage, getState, getUptime: () => formatUptime(Date.now() - ctx.metrics.activatedAt) };
}
