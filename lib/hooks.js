import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { isVillageSession, sanitize, extractConversationNonce, resolvePending, MAX_PARAM_LENGTH } from "./helpers.js";

export function registerHooks(ctx) {
  const { api } = ctx;

  // Cache resolved workspace prefix and ensure memory dir once
  const wsPrefix = resolve(ctx.workspaceDir) + "/";
  const memDir = join(ctx.workspaceDir, "memory");
  const villageMdPath = join(memDir, "village.md");
  try { mkdirSync(memDir, { recursive: true }); } catch {}

  // --- before_tool_call: capture actions + enforce tool access ---
  api.on("before_tool_call", (event, evtCtx) => {
    const sessionKey = evtCtx?.sessionKey;
    const toolName = event.name || event.toolName;

    if (isVillageSession(sessionKey)) {
      // Journal: write to local filesystem, don't capture as server action
      if (toolName === "village_journal") {
        const cfg = ctx.journalConfig;
        const text = sanitize(event.params?.entry || "", cfg.maxLength);
        if (text) {
          try {
            const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
            const content = cfg.format.replace("{timestamp}", ts).replace("{entry}", text);
            appendFileSync(villageMdPath, content);
          } catch (err) {
            api.logger.warn(`village: journal write failed: ${err.message}`);
          }
        }
        return; // allow (execute returns "OK"), not counted as action
      }

      // Capture active tool calls into pending actions
      if (ctx.activeToolDefs.has(toolName)) {
        const nonce = extractConversationNonce(sessionKey);
        if (nonce) {
          const entry = ctx.pending.get(nonce);
          if (entry && entry.actions.length < ctx.activeMaxActions) {
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
        if (resolved.startsWith(wsPrefix)) {
          const relative = resolved.slice(wsPrefix.length);
          if (ctx.activeAllowedReads.has(relative)) return;
        }
        return {
          block: true,
          blockReason: "This file is not accessible during village sessions.",
        };
      }

      // Always allow current_datetime
      if (toolName === "current_datetime") return;

      // Block everything else
      return {
        block: true,
        blockReason: "This tool is not available during village sessions.",
      };
    }

    // Normal session: block all registered village tools
    if (ctx.registeredTools.has(toolName)) {
      return {
        block: true,
        blockReason: "Village tools are only available during village sessions.",
      };
    }
  });

  // --- agent_end: resolve pending + extract usage ---
  api.on("agent_end", (event, evtCtx) => {
    const sessionKey = evtCtx?.sessionKey;
    if (!sessionKey || !isVillageSession(sessionKey)) return;

    const nonce = extractConversationNonce(sessionKey);
    if (!nonce) return;

    const entry = ctx.pending.get(nonce);
    if (entry) {
      const messages = event?.messages;
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const u = messages[i]?.usage || messages[i]?.message?.usage;
          if (u?.cost) { entry.usage = u; break; }
        }
      }
      const u = entry.usage;
      api.logger.info(`village: actions=[${entry.actions.map(a => a.tool).join(',') || 'none'}] cost=${u?.cost?.total ?? 0} in=${u?.input ?? 0} out=${u?.output ?? 0} cr=${u?.cacheRead ?? 0} cw=${u?.cacheWrite ?? 0}`);
      resolvePending(ctx.pending, nonce);
    }
  });

  // --- before_prompt_build: clean context for village sessions, inject command results ---
  api.on("before_prompt_build", (event, evtCtx) => {
    const sessionKey = evtCtx?.sessionKey || "";

    // Village sessions: clear message history so each tick gets clean context
    if (isVillageSession(sessionKey)) {
      if (Array.isArray(event?.messages) && event.messages.length > 0) {
        api.logger.info(`[village] clearing ${event.messages.length} history messages for clean tick context`);
        event.messages.splice(0);
      }
      return;
    }

    if (sessionKey.includes(":group:")) return;

    // Village command result (e.g. /village agenda, /village status)
    if (ctx.villageCommandResult) {
      const result = ctx.villageCommandResult;
      ctx.villageCommandResult = null;
      return {
        prependContext:
          `[SYSTEM] The user sent a village control command. ` +
          `Result: ${result} ` +
          `Briefly confirm this to the user in one short sentence.`,
      };
    }

    // DM session with active village bot — inject agenda tool hint
    if (ctx.remoteState.botName) {
      const agendaPart = ctx.cachedAgenda
        ? `Your current village agenda is: "${ctx.cachedAgenda}".`
        : `You have no village agenda set yet.`;
      return {
        prependContext:
          `[SYSTEM] You are participating in a village game. ${agendaPart} ` +
          `If your owner tells you what to do or focus on in the village, ` +
          `use the set_village_agenda tool to set it as your goal. ` +
          `Do NOT just discuss it — actually call the tool.`,
      };
    }
  });

  // --- Deploy file-based bootstrap hook ---
  deployBootstrapHook(ctx);
}

function deployBootstrapHook(ctx) {
  try {
    const hooksDir = join(ctx.workspaceDir, "hooks", "village-bootstrap");
    mkdirSync(hooksDir, { recursive: true });
    const hookMd = `---
name: village-bootstrap
description: Strip bootstrap files for village sessions
metadata:
  openclaw:
    events: ["agent:bootstrap"]
---
`;
    const handlerJs = `export default async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;
  const sk = event.context?.sessionKey;
  if (!sk || (!(sk.includes(":village:") || sk.endsWith(":village")) && !(sk.includes(":survival:") || sk.endsWith(":survival")))) return;
  const prompt = globalThis.__ggbot_village_prompt__
    || "You are in a village game. Respond with actions based on the scene.";
  event.context.bootstrapFiles = [{
    name: "AGENTS.md",
    path: "village-bootstrap",
    content: prompt,
    missing: false
  }];
};
`;
    writeFileSync(join(hooksDir, "HOOK.md"), hookMd);
    writeFileSync(join(hooksDir, "handler.js"), handlerJs);
    ctx.api.logger.info("village: deployed bootstrap hook to workspace/hooks/village-bootstrap/");
  } catch (err) {
    ctx.api.logger.warn(`village: failed to deploy bootstrap hook: ${err.message}`);
  }
}
