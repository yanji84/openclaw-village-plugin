import { isAllowedToolName, isVillageSession, resolvePending } from "./helpers.js";

export function createSceneProcessor(ctx, callGatewayRpc) {
  const { api } = ctx;

  // Register village_journal as always-available in village sessions
  api.registerTool((toolCtx) => {
    if (!isVillageSession(toolCtx?.sessionKey)) return null;
    return {
      name: "village_journal",
      description: "Write a memory entry to your personal journal. Use this to record observations, thoughts, plans, or anything you want to remember across ticks. Be selective — write what matters to you, not everything that happened.",
      parameters: {
        type: "object",
        properties: {
          entry: { type: "string", description: "Your journal entry (max 500 chars)" },
        },
        required: ["entry"],
      },
      execute: async () => ({ content: [{ type: "text", text: "OK" }] }),
    };
  }, { name: "village_journal" });
  ctx.registeredTools.add("village_journal");

  return async function processScene(conversationId, payload) {
    const scene = payload.scene;
    if (!scene) throw new Error("No scene in payload");
    api.logger.info(`village: payload v=${payload.v} agenda=${!!payload.agenda} tools=${payload.tools?.length ?? 0} scene=${scene.length}chars`);

    // 1. Update active tool definitions (used by factories + hooks)
    ctx.activeToolDefs.clear();
    for (const t of payload.tools || []) {
      if (isAllowedToolName(t.name)) {
        ctx.activeToolDefs.set(t.name, t);
      }
    }

    // 2. Register factories for new tool names (once per name, factory reads activeToolDefs)
    for (const name of ctx.activeToolDefs.keys()) {
      if (!ctx.registeredTools.has(name)) {
        api.registerTool((toolCtx) => {
          if (!isVillageSession(toolCtx.sessionKey)) return null;
          const def = ctx.activeToolDefs.get(name);
          if (!def) return null;
          return {
            name: def.name,
            description: def.description,
            parameters: def.parameters,
            execute: async () => ({ content: [{ type: "text", text: "OK" }] }),
          };
        }, { name });
        ctx.registeredTools.add(name);
      }
    }

    // 3. Set active scene context for bootstrap hook (globalThis IPC)
    ctx.activeSystemPrompt = payload.systemPrompt || null;
    globalThis.__ggbot_village_prompt__ = ctx.activeSystemPrompt || "";
    ctx.activeAllowedReads = new Set(payload.allowedReads || []);
    ctx.activeMaxActions = payload.maxActions || 2;
    ctx.activeSceneTimeoutMs = payload.sceneTimeoutMs || ctx.DEFAULT_SCENE_TIMEOUT_MS;
    ctx.activeRpcTimeoutMs = payload.rpcTimeoutMs || ctx.DEFAULT_RPC_TIMEOUT_MS;
    if (payload.agenda !== undefined) ctx.cachedAgenda = payload.agenda;

    // 4. Create pending entry for action capture
    let resolveEntry;
    const entryPromise = new Promise((r) => { resolveEntry = r; });
    ctx.pending.set(conversationId, { actions: [], usage: null, resolve: resolveEntry });

    const port = api.config?.gateway?.port;
    const token = api.config?.gateway?.auth?.token;
    if (!port || !token) {
      ctx.pending.delete(conversationId);
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
      timeoutMs: ctx.activeRpcTimeoutMs,
    }).catch((err) => {
      api.logger.warn(`village: agent RPC failed: ${err.message}`);
      resolvePending(ctx.pending, conversationId);
    });

    const timer = setTimeout(() => {
      resolvePending(ctx.pending, conversationId);
    }, ctx.activeSceneTimeoutMs);

    const entry = await entryPromise;
    clearTimeout(timer);
    ctx.pending.delete(conversationId);

    // 5. Return captured actions (fallback to first active tool or village_observe)
    const fallback = [...ctx.activeToolDefs.keys()][0] || "village_observe";
    const actions = entry.actions.length > 0
      ? entry.actions
      : [{ tool: fallback, params: {} }];

    const result = { actions };
    if (entry.usage) result.usage = entry.usage;

    await rpcPromise;
    return result;
  };
}
