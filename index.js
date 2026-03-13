/**
 * Village Plugin v2
 *
 * Generic remote agent executor for the village game server.
 * All game-specific logic (tools, prompts, privacy rules) is delivered
 * by the server via the v2 payload protocol. The plugin handles
 * transport (gateway RPC, poll loop, heartbeat) and memory (journal) only.
 *
 * v2 payload: { v, scene, tools, systemPrompt, allowedReads, maxActions }
 */

import { readFileSync, readdirSync, watchFile, unwatchFile } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateDeviceIdentity } from "./lib/device-auth.js";
import { createGatewayRpc } from "./lib/gateway-rpc.js";
import { createSceneProcessor } from "./lib/scene-processor.js";
import { createPollLoop } from "./lib/poll-loop.js";
import { createHubClient } from "./lib/hub-client.js";
import { registerHooks } from "./lib/hooks.js";
import { registerCommands } from "./lib/commands.js";

// --- Plugin version ---
let pluginVersion = "unknown";
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
  pluginVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
} catch {}

const deviceIdentity = generateDeviceIdentity();

/**
 * Parse an extension markdown file with YAML-like frontmatter.
 * Format:
 *   ---
 *   tools:
 *     - tool_name_a
 *     - tool_name_b
 *   ---
 *   Prompt text for the LLM...
 */
function parseExtension(raw, filename) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const prompt = match[2].trim();

  const tools = new Set();
  const toolLines = frontmatter.match(/^\s*-\s+(.+)$/gm);
  if (toolLines) {
    for (const line of toolLines) {
      const name = line.replace(/^\s*-\s+/, "").trim();
      if (name) tools.add(name);
    }
  }

  const name = filename.replace(/\.md$/, "");
  return { name, tools, prompt };
}

/** @type {import('openclaw').OpenClawPluginDefinition} */
export default {
  id: "ggbot-village",
  name: "Village",
  description: "Village game agent executor — v2 protocol",

  activate(api) {
    // --- Shared context ---
    if (!process.__villageRemote) {
      process.__villageRemote = { running: false, botName: null, pollAbort: null, hubConnected: false };
    }
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

    const ctx = {
      api,
      pluginVersion,
      instanceId: Math.random().toString(36).slice(2, 10),
      deviceIdentity,
      workspaceDir: api.config?.agents?.defaults?.workspace || "/workspace",

      // Environment
      VILLAGE_HUB: process.env.VILLAGE_HUB,
      VILLAGE_TOKEN: process.env.VILLAGE_TOKEN,

      // Tool state
      registeredTools: new Set(),
      activeToolDefs: new Map(),
      activeSystemPrompt: null,
      activeAllowedReads: new Set(),
      activeMaxActions: 2,
      pending: new Map(),

      // Timeouts
      DEFAULT_SCENE_TIMEOUT_MS: 40_000,
      DEFAULT_RPC_TIMEOUT_MS: 45_000,
      activeSceneTimeoutMs: 40_000,
      activeRpcTimeoutMs: 45_000,
      POLL_TIMEOUT_MS: 125_000,
      BACKOFF_MS: 5_000,

      // Journal
      journalConfig: { maxLength: 500, format: "\n### {timestamp}\n{entry}\n" },

      // Owner persona (loaded from workspace/village-persona.md)
      ownerPersona: null,

      // Local extensions (loaded from workspace/village-extensions/*.md)
      extensions: [],          // [{ name, tools: Set, prompt: string }]
      extensionTools: new Set(), // flattened set of all extension tool names

      // DM command state
      villageCommandResult: null,
      cachedAgenda: null,

      // Process-level singletons
      remoteState: process.__villageRemote,
      metrics: process.__villageMetrics,
    };

    // --- Wire modules ---
    const callGatewayRpc = createGatewayRpc(deviceIdentity);
    const processScene = createSceneProcessor(ctx, callGatewayRpc);

    ctx.remoteState.api = api;
    ctx.remoteState.processScene = processScene;

    // Hub client and poll loop have a circular dependency — resolve with late binding
    let hubClient;
    const { startPolling, stopPolling } = createPollLoop(ctx, (...args) => hubClient.hubRequest(...args));
    hubClient = createHubClient(ctx, { startPolling, stopPolling });

    // --- Load owner persona ---
    const personaPath = join(ctx.workspaceDir, "village-persona.md");
    function loadPersona() {
      try {
        const text = readFileSync(personaPath, "utf-8").trim();
        if (text) {
          ctx.ownerPersona = text;
          api.logger.info(`village: loaded owner persona (${text.length} chars)`);
        } else {
          ctx.ownerPersona = null;
        }
      } catch {
        ctx.ownerPersona = null;
      }
    }
    loadPersona();
    watchFile(personaPath, { interval: 10_000 }, loadPersona);

    // --- Load local extensions ---
    const extensionsDir = join(ctx.workspaceDir, "village-extensions");
    function loadExtensions() {
      const exts = [];
      const toolSet = new Set();
      try {
        const files = readdirSync(extensionsDir).filter(f => f.endsWith(".md"));
        for (const file of files) {
          try {
            const raw = readFileSync(join(extensionsDir, file), "utf-8");
            const ext = parseExtension(raw, file);
            if (ext) {
              exts.push(ext);
              for (const t of ext.tools) toolSet.add(t);
            }
          } catch {}
        }
      } catch {}
      ctx.extensions = exts;
      ctx.extensionTools = toolSet;
      if (exts.length > 0) {
        api.logger.info(`village: loaded ${exts.length} extension(s): ${exts.map(e => e.name).join(", ")} (${toolSet.size} tools)`);
      }
    }
    loadExtensions();
    watchFile(extensionsDir, { interval: 10_000 }, loadExtensions);

    registerHooks(ctx);
    registerCommands(ctx, hubClient);

    // --- Passive remote mode setup ---
    if (ctx.VILLAGE_HUB && ctx.VILLAGE_TOKEN) {
      api.logger.info(`[village] instanceId=${ctx.instanceId}`);
      api.logger.info(`[village] hub configured: ${ctx.VILLAGE_HUB} (use /village join to connect)`);

      // Clear stale join state then auto-join
      (async () => {
        try { await hubClient.hubRequest("POST", "/api/village/leave", {}, 3_000); } catch {}
        await new Promise(r => setTimeout(r, 3_000));
        if (!ctx.remoteState.running) {
          api.logger.info("[village] auto-joining hub...");
          try {
            await hubClient.joinVillage();
          } catch (err) {
            api.logger.warn(`village: auto-join failed: ${err.message}`);
          }
        }
      })();

      // Version check
      fetch("https://registry.npmjs.org/ggbot-village/latest", {
        signal: AbortSignal.timeout(5_000),
      }).then(r => r.json()).then(data => {
        const latest = data.version;
        if (latest && latest !== pluginVersion) {
          api.logger.warn(`village: update available! v${pluginVersion} → v${latest}. Run: openclaw plugins install ggbot-village@${latest}`);
        }
      }).catch(() => {});

      if (!process.__villageSigtermRegistered) {
        process.__villageSigtermRegistered = true;
        process.on("SIGTERM", () => {
          unwatchFile(personaPath);
          unwatchFile(extensionsDir);
          const rs = process.__villageRemote;
          if (rs?.running) {
            rs.running = false;
            stopPolling();
            if (rs.botName) {
              hubClient.hubRequest("POST", "/api/village/leave", {}).catch(() => {});
            }
          }
        });
      }
    } else {
      api.logger.warn("village: VILLAGE_HUB/VILLAGE_TOKEN not set — remote mode unavailable");
    }

    api.logger.info("village: plugin activated (v2 protocol)");
  },
};
