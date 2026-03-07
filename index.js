/**
 * Village Plugin v2
 *
 * Generic remote agent executor for the village game server.
 * All game-specific logic (tools, prompts, privacy rules) is delivered
 * by the server via the v2 payload protocol. The plugin handles
 * transport (gateway RPC, poll loop, heartbeat) only.
 *
 * v2 payload: { v, scene, tools, systemPrompt, allowedReads, maxActions }
 */

import { readFileSync, appendFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createHash, createPrivateKey, sign } from "node:crypto";

// --- Plugin version ---
let pluginVersion = "unknown";
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
  pluginVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
} catch {}

// --- Device identity for gateway RPC (operator.write scope requires signed device auth) ---

function generateDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const raw = spkiDer.subarray(spkiDer.length - 32);
  const deviceId = createHash("sha256").update(raw).digest("hex");
  const publicKeyB64Url = raw.toString("base64url");
  return { deviceId, publicKeyPem, privateKeyPem, publicKeyB64Url };
}

function signPayload(privateKeyPem, payload) {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

function buildDeviceAuth({ deviceId, publicKeyB64Url, privateKeyPem, clientId, clientMode, role, scopes, token, nonce }) {
  const signedAtMs = Date.now();
  const payload = [
    "v2", deviceId, clientId, clientMode, role, scopes.join(","),
    String(signedAtMs), token || "", nonce,
  ].join("|");
  const signature = signPayload(privateKeyPem, payload);
  return { id: deviceId, publicKey: publicKeyB64Url, signature, signedAt: signedAtMs, nonce };
}

const deviceIdentity = generateDeviceIdentity();

/** @type {import('openclaw').OpenClawPluginDefinition} */
export default {
  id: "ggbot-village",
  name: "Village",
  description: "Village game agent executor — v2 protocol",

  activate(api) {
    // --- State ---
    const registeredTools = new Set();      // tool names with registered factories
    const activeToolDefs = new Map();       // name → { name, description, parameters } (current scene)
    let activeSystemPrompt = null;          // injected via before_prompt_build
    let activeAllowedReads = new Set();     // workspace-relative paths the read tool may access
    let activeMaxActions = 2;
    let activeJournalConfig = null;         // { maxLength, format } from server payload
    const pending = new Map();              // conversationId → { actions, usage, resolve }

    const MAX_PARAM_LENGTH = 500;
    const DEFAULT_SCENE_TIMEOUT_MS = 40_000;
    const DEFAULT_RPC_TIMEOUT_MS = 45_000;
    let activeSceneTimeoutMs = DEFAULT_SCENE_TIMEOUT_MS;
    let activeRpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS;

    // --- Security: tool name prefix allowlist ---
    const ALLOWED_PREFIXES = ["village_", "survival_", "game_", "dnd_"];
    function isAllowedToolName(name) {
      return typeof name === "string" && ALLOWED_PREFIXES.some(p => name.startsWith(p));
    }

    // --- Helpers ---

    function isVillageSession(sessionKey) {
      return typeof sessionKey === "string" && (sessionKey.includes("village:") || sessionKey.includes("survival:"));
    }

    function sanitize(text, maxLen = MAX_PARAM_LENGTH) {
      if (typeof text !== "string") return "";
      return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLen);
    }

    function extractConversationNonce(sessionKey) {
      if (!sessionKey) return null;
      let idx = sessionKey.indexOf("village:");
      if (idx === -1) idx = sessionKey.indexOf("survival:");
      if (idx === -1) return null;
      return sessionKey.slice(idx);
    }

    // --- Gateway RPC ---

    function callGatewayRpc({ port, token, method, params, timeoutMs = RPC_TIMEOUT_MS }) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        let reqId = 0;
        let connectSent = false;
        let connectResolved = false;
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`${method} WebSocket timeout (${timeoutMs / 1000}s)`));
        }, timeoutMs);

        function sendConnect(nonce) {
          if (connectSent) return;
          connectSent = true;
          const device = buildDeviceAuth({
            deviceId: deviceIdentity.deviceId,
            publicKeyB64Url: deviceIdentity.publicKeyB64Url,
            privateKeyPem: deviceIdentity.privateKeyPem,
            clientId: "gateway-client",
            clientMode: "backend",
            role: "operator",
            scopes: ["operator.write"],
            token,
            nonce,
          });
          ws.send(JSON.stringify({
            type: "req",
            id: String(++reqId),
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "gateway-client",
                displayName: "Village Plugin",
                version: "1.0.0",
                platform: "node",
                mode: "backend",
              },
              auth: { token },
              role: "operator",
              scopes: ["operator.write"],
              device,
            },
          }));
        }

        ws.addEventListener("message", (evt) => {
          let frame;
          try {
            frame = JSON.parse(
              typeof evt.data === "string" ? evt.data : evt.data.toString()
            );
          } catch {
            return;
          }

          if (frame.type === "event" && frame.event === "connect.challenge") {
            sendConnect(frame.payload?.nonce || "");
            return;
          }

          if (frame.type === "event") return;

          if (frame.type === "res" && !connectResolved && frame.ok === true) {
            connectResolved = true;
            ws.send(JSON.stringify({
              type: "req",
              id: String(++reqId),
              method,
              params,
            }));
            return;
          }

          if (connectResolved && (frame.type === "res" || frame.type === "final")) {
            clearTimeout(timeout);
            ws.close();
            if (frame.error || frame.ok === false) {
              reject(new Error(frame.error?.message || `${method} RPC error`));
            } else {
              resolve(frame.result || frame.payload);
            }
            return;
          }

          if (frame.type === "error") {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(frame.message || frame.error || "WebSocket error"));
          }
        });

        ws.addEventListener("error", (err) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${err.message || String(err)}`));
        });

        ws.addEventListener("close", () => {
          clearTimeout(timeout);
          if (!connectResolved) {
            reject(new Error("WebSocket closed before connect"));
          }
        });
      });
    }

    // --- Workspace ---
    const workspaceDir = api.config?.agents?.defaults?.workspace || "/workspace";

    // --- Core scene processor ---

    async function processScene(conversationId, payload) {
      const scene = payload.scene;
      if (!scene) throw new Error("No scene in payload");

      // 1. Update active tool definitions (used by factories + hooks)
      activeToolDefs.clear();
      for (const t of payload.tools || []) {
        if (isAllowedToolName(t.name)) {
          activeToolDefs.set(t.name, t);
        }
      }

      // 2. Register factories for new tool names (once per name, factory reads activeToolDefs)
      for (const name of activeToolDefs.keys()) {
        if (!registeredTools.has(name)) {
          api.registerTool((ctx) => {
            if (!isVillageSession(ctx.sessionKey)) return null;
            const def = activeToolDefs.get(name);
            if (!def) return null;
            return {
              name: def.name,
              description: def.description,
              parameters: def.parameters,
              execute: async () => ({ content: [{ type: "text", text: "OK" }] }),
            };
          }, { name });
          registeredTools.add(name);
        }
      }

      // 3. Set active scene context
      activeSystemPrompt = payload.systemPrompt || null;
      activeAllowedReads = new Set(payload.allowedReads || []);
      activeMaxActions = payload.maxActions || 2;
      activeJournalConfig = payload.journalConfig || null;
      activeSceneTimeoutMs = payload.sceneTimeoutMs || DEFAULT_SCENE_TIMEOUT_MS;
      activeRpcTimeoutMs = payload.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;

      // 3. Create pending entry for action capture
      let resolveEntry;
      const entryPromise = new Promise((r) => { resolveEntry = r; });
      pending.set(conversationId, { actions: [], usage: null, resolve: resolveEntry });

      const port = api.config?.gateway?.port;
      const token = api.config?.gateway?.auth?.token;
      if (!port || !token) {
        pending.delete(conversationId);
        throw new Error("Gateway port/token not configured");
      }

      const rpcPromise = callGatewayRpc({
        port,
        token,
        method: "agent",
        params: {
          message: scene,
          sessionKey: conversationId,
          deliver: false,
          idempotencyKey: `village-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        timeoutMs: activeRpcTimeoutMs,
      }).catch((err) => {
        api.logger.warn(`village: agent RPC failed: ${err.message}`);
        const entry = pending.get(conversationId);
        if (entry) {
          entry.resolve(entry);
          pending.delete(conversationId);
        }
      });

      const timer = setTimeout(() => {
        const entry = pending.get(conversationId);
        if (entry) {
          entry.resolve(entry);
          pending.delete(conversationId);
        }
      }, activeSceneTimeoutMs);

      const entry = await entryPromise;
      clearTimeout(timer);
      pending.delete(conversationId);

      // 4. Return captured actions (fallback to first active tool or village_observe)
      const fallback = [...activeToolDefs.keys()][0] || "village_observe";
      const actions = entry.actions.length > 0
        ? entry.actions
        : [{ tool: fallback, params: {} }];

      const result = { actions };
      if (entry.usage) result.usage = entry.usage;

      await rpcPromise;
      return result;
    }

    // --- Hook: before_tool_call — generic capture + enforce ---

    api.on("before_tool_call", (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      const toolName = event.name || event.toolName;

      if (isVillageSession(sessionKey)) {
        // Journal: write to local filesystem, don't capture as server action
        if (toolName === "village_journal") {
          const cfg = activeJournalConfig || { maxLength: 500, format: "\n### {timestamp}\n{entry}\n" };
          const text = sanitize(event.params?.entry || "", cfg.maxLength);
          if (text) {
            try {
              const memDir = join(workspaceDir, "memory");
              mkdirSync(memDir, { recursive: true });
              const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
              const content = cfg.format.replace("{timestamp}", ts).replace("{entry}", text);
              appendFileSync(join(memDir, "village.md"), content);
            } catch (err) {
              api.logger.warn(`village: journal write failed: ${err.message}`);
            }
          }
          return; // allow (execute returns "OK"), not counted as action
        }

        // Capture active tool calls into pending actions
        if (activeToolDefs.has(toolName)) {
          const nonce = extractConversationNonce(sessionKey);
          if (nonce) {
            const entry = pending.get(nonce);
            if (entry && entry.actions.length < activeMaxActions) {
              // Generic param sanitization
              const params = {};
              for (const [k, v] of Object.entries(event.params || {})) {
                if (v == null) params[k] = "";
                else if (typeof v === "string") params[k] = sanitize(v, MAX_PARAM_LENGTH);
                else if (typeof v === "number" || typeof v === "boolean") params[k] = v;
              }
              entry.actions.push({ tool: toolName, params });
            }
          }
          return; // allow (execute returns "OK")
        }

        // Allow read for files in allowedReads
        if (toolName === "read") {
          const filePath = event.params?.file_path || event.params?.path || event.params?.file || "";
          const resolved = resolve(filePath);
          const wsPrefix = resolve(workspaceDir) + "/";
          if (resolved.startsWith(wsPrefix)) {
            const relative = resolved.slice(wsPrefix.length);
            if (activeAllowedReads.has(relative)) return; // allow
          }
          return {
            block: true,
            blockReason: "This file is not accessible during village sessions.",
          };
        }

        // Always allow current_datetime
        if (toolName === "current_datetime") return;

        // Block everything else (including memory tools)
        return {
          block: true,
          blockReason: "This tool is not available during village sessions.",
        };
      }

      // Normal session: block all registered village tools
      if (registeredTools.has(toolName)) {
        return {
          block: true,
          blockReason: "Village tools are only available during village sessions.",
        };
      }
    });

    // --- Hook: agent_end — resolve pending + extract usage ---

    api.on("agent_end", (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey || !isVillageSession(sessionKey)) return;

      const nonce = extractConversationNonce(sessionKey);
      if (!nonce) return;

      const entry = pending.get(nonce);
      if (entry) {
        const messages = event?.messages;
        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const u = messages[i]?.usage || messages[i]?.message?.usage;
            if (u?.cost) { entry.usage = u; break; }
          }
        }
        entry.resolve(entry);
        pending.delete(nonce);
      }
    });

    // --- Hook: before_prompt_build — inject active system prompt ---

    api.on("before_prompt_build", (_event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!isVillageSession(sessionKey)) return;
      if (activeSystemPrompt) return { prependContext: activeSystemPrompt };
    });

    // --- Remote polling mode ---

    const VILLAGE_HUB = process.env.VILLAGE_HUB;
    const VILLAGE_TOKEN = process.env.VILLAGE_TOKEN;

    if (!process.__villageRemote) {
      process.__villageRemote = { running: false, botName: null, pollAbort: null, hubConnected: false };
    }
    const remoteState = process.__villageRemote;
    remoteState.api = api;
    remoteState.processScene = processScene;

    if (!process.__villageMetrics) {
      process.__villageMetrics = {
        activatedAt: Date.now(),
        scenesProcessed: 0,
        scenesFailed: 0,
        sceneTotalMs: 0,
        lastSceneAt: null,
        pollErrors: 0,
        lastHeartbeatAt: null,
      };
    }
    const metrics = process.__villageMetrics;

    const instanceId = Math.random().toString(36).slice(2, 10);

    function formatUptime(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return `${h}h${m % 60}m`;
      if (m > 0) return `${m}m${s % 60}s`;
      return `${s}s`;
    }

    function getState() {
      if (!remoteState.running) return 'OFFLINE';
      if (!remoteState.hubConnected) return 'CONNECTING';
      if (remoteState.botName) return 'IN_GAME';
      return 'CONNECTED';
    }

    let villageCommandResult = null;
    let POLL_TIMEOUT_MS = 125_000;
    let BACKOFF_MS = 5_000;

    function applyRemoteConfig(cfg) {
      if (!cfg) return;
      // Transport tuning only — scene/RPC timeouts come from v2 payload
      if (cfg.pollTimeoutMs) POLL_TIMEOUT_MS = cfg.pollTimeoutMs;
      if (cfg.backoffMs) BACKOFF_MS = cfg.backoffMs;
    }

    async function hubRequest(method, path, body, timeoutMs = 15_000) {
      if (!VILLAGE_HUB || !VILLAGE_TOKEN) {
        throw new Error("VILLAGE_HUB/VILLAGE_TOKEN not configured");
      }
      const url = `${VILLAGE_HUB}${path}`;
      const opts = {
        method,
        headers: {
          "Authorization": `Bearer ${VILLAGE_TOKEN}`,
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

    // --- Join/Leave village (remote bots) ---

    async function joinVillage() {
      const { api: a } = remoteState;
      a.logger.info(`village: joining remote village at ${VILLAGE_HUB}`);
      for (let attempt = 0; attempt < 3; attempt++) {
        const { status, data } = await hubRequest("POST", "/api/village/join", {});
        if (status >= 400 && status !== 409) {
          throw new Error(data?.error || `join failed (${status})`);
        }
        if (data?.botName) {
          remoteState.botName = data.botName;
          applyRemoteConfig(data.config);
          break;
        }
        a.logger.warn(`village: join response missing botName (attempt ${attempt + 1}), retrying`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!remoteState.botName) {
        throw new Error("join response never included botName");
      }
      startPolling();
      remoteState.api.logger.info(`[village] state: CONNECTED → IN_GAME (bot: ${remoteState.botName})`);
    }

    async function leaveVillage() {
      stopPolling();
      await hubRequest("POST", "/api/village/leave", {}).catch(() => {});
      remoteState.botName = null;
      api.logger.info("[village] state: IN_GAME → CONNECTED (leave request)");
    }

    // --- Poll loop ---

    function startPolling() {
      if (remoteState.pollAbort) return;
      const ac = new AbortController();
      remoteState.pollAbort = ac;

      pollLoop(ac.signal).then((reason) => {
        if (remoteState.pollAbort === ac) remoteState.pollAbort = null;
        if (reason === "kicked") {
          remoteState.api.logger.warn(`[village] state: IN_GAME → CONNECTED (kicked)`);
        } else if (reason === "removed") {
          remoteState.api.logger.warn("[village] state: IN_GAME → CONNECTED (removed from game)");
          remoteState.botName = null;
        }
      });
    }

    function stopPolling() {
      if (remoteState.pollAbort) {
        remoteState.pollAbort.abort();
        remoteState.pollAbort = null;
      }
    }

    function isTimeoutError(err) {
      return err.name === "TimeoutError" || err.message?.includes("aborted");
    }

    async function backoff(isError) {
      if (isError) {
        metrics.pollErrors++;
        await new Promise(r => setTimeout(r, BACKOFF_MS));
      }
    }

    async function processSceneSafe(conversationId, payload) {
      const t0 = Date.now();
      try {
        const result = await remoteState.processScene(conversationId, payload);
        metrics.scenesProcessed++;
        metrics.sceneTotalMs += (Date.now() - t0);
        metrics.lastSceneAt = Date.now();
        return result;
      } catch (err) {
        metrics.scenesFailed++;
        metrics.sceneTotalMs += (Date.now() - t0);
        remoteState.api.logger.warn(`village: processScene failed: ${err.message}`);
        return { actions: [{ tool: "village_observe", params: {} }] };
      }
    }

    async function pollLoop(signal) {
      while (!signal.aborted) {
        try {
          const { status, data } = await hubRequest(
            "GET", `/api/village/poll/${remoteState.botName}`, undefined, POLL_TIMEOUT_MS
          );

          if (signal.aborted) return "stopped";
          if (status === 410) return "removed";
          if (status !== 200) { await backoff(status >= 400); continue; }

          // Poison pill: server kicked this bot
          if (data.kick) {
            remoteState.api.logger.info(`village: kicked by server: ${data.reason || "no reason"}`);
            remoteState.botName = null;
            return "kicked";
          }

          const { requestId, conversationId, ...v2Payload } = data;
          const result = await processSceneSafe(conversationId, v2Payload);
          await hubRequest("POST", `/api/village/respond/${requestId}`, result).catch(() => {});

        } catch (err) {
          if (signal.aborted) return "stopped";
          if (!isTimeoutError(err)) await backoff(true);
        }
      }
      return "stopped";
    }

    // --- Heartbeat ---

    const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

    function buildHeartbeat() {
      const uptimeMs = Date.now() - metrics.activatedAt;
      const avgSceneMs = metrics.scenesProcessed > 0
        ? Math.round(metrics.sceneTotalMs / metrics.scenesProcessed)
        : null;

      let memoryFileCount = null;
      try {
        memoryFileCount = readdirSync(join(workspaceDir, "memory")).length;
      } catch {}

      let sessionCount = null;
      let sessionSizeBytes = null;
      try {
        const sessDir = join(workspaceDir, "..", ".openclaw", "agents", "main", "sessions");
        const files = readdirSync(sessDir).filter(f => f.endsWith(".jsonl"));
        sessionCount = files.length;
        sessionSizeBytes = files.reduce((sum, f) => {
          try { return sum + statSync(join(sessDir, f)).size; } catch { return sum; }
        }, 0);
      } catch {}

      return {
        version: pluginVersion,
        instanceId,
        uptimeMs,
        joined: !!remoteState.botName,
        scenesProcessed: metrics.scenesProcessed,
        scenesFailed: metrics.scenesFailed,
        avgSceneMs,
        lastSceneAt: metrics.lastSceneAt,
        pollErrors: metrics.pollErrors,
        memoryFileCount,
        sessionCount,
        sessionSizeBytes,
      };
    }

    async function heartbeatLoop() {
      while (remoteState.running) {
        await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS));
        if (!remoteState.running) break;
        try {
          const { data: hbResp } = await hubRequest("POST", "/api/village/heartbeat", buildHeartbeat());
          metrics.lastHeartbeatAt = Date.now();
          applyRemoteConfig(hbResp?.config);
        } catch (err) {
          remoteState.api.logger.warn(`village: heartbeat failed: ${err.message}`);
        }
      }
    }

    // --- Health log loop (60s cadence) ---

    const HEALTH_LOG_INTERVAL_MS = 60_000;

    async function healthLogLoop() {
      while (remoteState.running) {
        await new Promise(r => setTimeout(r, HEALTH_LOG_INTERVAL_MS));
        if (!remoteState.running) break;
        const state = getState();
        const uptime = formatUptime(Date.now() - metrics.activatedAt);
        if (state === 'IN_GAME') {
          const avgMs = metrics.scenesProcessed > 0
            ? Math.round(metrics.sceneTotalMs / metrics.scenesProcessed)
            : null;
          api.logger.info(`[village] health: state=IN_GAME scenes=${metrics.scenesProcessed} errors=${metrics.pollErrors} avgScene=${avgMs != null ? `${avgMs}ms` : '-'} uptime=${uptime}`);
        } else if (state === 'CONNECTED') {
          const ago = metrics.lastHeartbeatAt
            ? `${Math.round((Date.now() - metrics.lastHeartbeatAt) / 1000)}s ago`
            : 'never';
          api.logger.info(`[village] health: state=CONNECTED hub=ok lastHeartbeat=${ago} uptime=${uptime}`);
        } else {
          api.logger.info(`[village] health: state=${state} hub=UNREACHABLE uptime=${uptime}`);
        }
      }
    }

    // --- Owner commands: /village-join, /village-leave ---

    api.on("message_received", (event, ctx) => {
      const sessionKey = ctx?.sessionKey || "";
      if (sessionKey.includes(":group:") || isVillageSession(sessionKey)) return;

      const text = (event?.text || event?.content || "").trim().toLowerCase();

      if (text === "/village status" || text === "/village-status") {
        const state = getState();
        const uptime = formatUptime(Date.now() - metrics.activatedAt);
        villageCommandResult = `Village: ${state} | uptime=${uptime} | scenes=${metrics.scenesProcessed} errors=${metrics.pollErrors}`;
      } else if (text === "/village-leave" || text === "/village leave") {
        if (!remoteState.botName) {
          villageCommandResult = "Not currently in the village.";
          return;
        }
        leaveVillage().catch(() => {});
        api.logger.info("village: owner requested leave");
        villageCommandResult = "Left the village. Use /village join to rejoin.";
      } else if (text === "/village-join" || text === "/village join") {
        if (remoteState.botName) {
          villageCommandResult = "Already in the village.";
          return;
        }
        joinVillage().catch((err) => {
          api.logger.error(`village: join failed: ${err.message}`);
        });
        api.logger.info("village: owner requested join");
        villageCommandResult = "Joining the village now.\nObserve: https://ggbot.it.com/village/";
      }
    });

    // --- Inject village command result into agent prompt ---

    api.on("before_prompt_build", (_event, ctx) => {
      if (!villageCommandResult) return;
      const sessionKey = ctx?.sessionKey || "";
      if (sessionKey.includes(":group:") || isVillageSession(sessionKey)) return;

      const result = villageCommandResult;
      villageCommandResult = null;

      return {
        prependContext:
          `[SYSTEM] The user sent a village control command. ` +
          `Result: ${result} ` +
          `Briefly confirm this to the user in one short sentence.`,
      };
    });

    // --- Auto-start remote mode ---

    if (VILLAGE_HUB && VILLAGE_TOKEN && !remoteState.running) {
      remoteState.running = true;
      api.logger.info(`[village] instanceId=${instanceId}`);
      api.logger.info(`[village] state: OFFLINE → CONNECTING (hub: ${VILLAGE_HUB})`);

      // Startup handshake — check if bot was in game (server is source of truth)
      // Retries on failure (Docker containers may have slow DNS at boot)
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { status, data } = await hubRequest("POST", "/api/village/hello", {});
            if (status === 200) {
              remoteState.hubConnected = true;
              api.logger.info(`[village] state: CONNECTING → CONNECTED (hub: ${VILLAGE_HUB}, game: ${data.game || "none"})`);
              hubRequest("POST", "/api/village/heartbeat", buildHeartbeat()).catch(() => {});
              if (data.inGame && data.botName) {
                remoteState.botName = data.botName;
                startPolling();
                api.logger.info(`[village] state: CONNECTED → IN_GAME (resuming as ${data.botName})`);
              }
              return;
            }
            api.logger.error(`village: hub handshake failed (${status}): ${data?.error || "unknown error"}`);
            return;
          } catch (err) {
            api.logger.warn(`village: hub unreachable (attempt ${attempt + 1}/3): ${err.message}`);
            if (attempt < 2) await new Promise(r => setTimeout(r, 5_000));
          }
        }
        api.logger.error("[village] state: CONNECTING → OFFLINE (hub unreachable after 3 attempts)");
      })();

      fetch("https://registry.npmjs.org/ggbot-village/latest", {
        signal: AbortSignal.timeout(5_000),
      }).then(r => r.json()).then(data => {
        const latest = data.version;
        if (latest && latest !== pluginVersion) {
          api.logger.warn(`village: update available! v${pluginVersion} → v${latest}. Run: openclaw plugins install ggbot-village@${latest}`);
        }
      }).catch(() => {});

      heartbeatLoop().catch((err) => {
        remoteState.api.logger.warn(`village: heartbeat loop ended: ${err.message}`);
      });

      healthLogLoop().catch((err) => {
        remoteState.api.logger.warn(`village: health log loop ended: ${err.message}`);
      });

      process.on("SIGTERM", () => {
        remoteState.running = false;
        stopPolling();
        if (remoteState.botName) {
          hubRequest("POST", "/api/village/leave", {}).catch(() => {});
        }
      });

      api.logger.info("village: remote mode enabled — " + VILLAGE_HUB);
    } else if (VILLAGE_HUB && VILLAGE_TOKEN && remoteState.running) {
      api.logger.info("village: remote mode already running (refs updated)");
    }

    api.logger.info("village: plugin activated (v2 protocol)");
  },
};
