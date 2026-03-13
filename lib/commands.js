import { isDmSession, sanitize } from "./helpers.js";

export function registerCommands(ctx, hubClient) {
  const { api } = ctx;
  const { joinVillage, leaveVillage, getState, hubRequest } = hubClient;

  // --- DM-only tool: set_village_agenda ---
  api.registerTool((toolCtx) => {
    const sk = toolCtx?.sessionKey || "";
    if (!isDmSession(sk)) return null;
    if (!ctx.remoteState.botName) return null;
    return {
      name: "set_village_agenda",
      description: "Set your village agenda/goal based on what your owner tells you. Call this when your owner describes what they want you to focus on in the village.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The village agenda/goal, concise (max 100 chars)" },
        },
        required: ["goal"],
      },
      execute: async (_toolCallId, params) => {
        const goal = sanitize(params?.goal, 100).trim();
        if (!goal) return { content: [{ type: "text", text: "No goal provided." }] };
        ctx.cachedAgenda = goal;
        hubRequest("POST", `/api/village/agenda/${ctx.remoteState.botName}`, { goal }).catch((err) => {
          api.logger.warn(`village: set agenda failed: ${err.message}`);
        });
        return { content: [{ type: "text", text: `Village agenda set to: "${goal}"` }] };
      },
    };
  }, { name: "set_village_agenda" });

  // --- Owner commands: /village join|leave|status|agenda ---
  api.on("message_received", (event, evtCtx) => {
    const sessionKey = evtCtx?.sessionKey || "";
    if (!isDmSession(sessionKey)) return;

    const text = (event?.text || event?.content || "").trim().toLowerCase();

    if (text === "/village status" || text === "/village-status") {
      const state = getState();
      const uptime = hubClient.getUptime();
      if (state === "OFFLINE") {
        ctx.villageCommandResult = `Village: not connected. Use /village join to connect.`;
      } else if (state === "CONNECTED" || state === "CONNECTING") {
        ctx.villageCommandResult = `Village: connected to hub. Use /village join to join a game. | uptime=${uptime}`;
      } else {
        ctx.villageCommandResult = `Village: ${state} | bot=${ctx.remoteState.botName} | uptime=${uptime} | scenes=${ctx.metrics.scenesProcessed} errors=${ctx.metrics.pollErrors}`;
      }
    } else if (text === "/village agenda" || text === "/village-agenda") {
      ctx.villageCommandResult = ctx.cachedAgenda
        ? `Village agenda: "${ctx.cachedAgenda}"`
        : `No village agenda set. Tell me what you want your bot to focus on in the village, and I'll set it as the agenda.`;
    } else if (text === "/village-leave" || text === "/village leave") {
      if (!ctx.remoteState.botName) {
        ctx.villageCommandResult = "Not currently in the village.";
        return;
      }
      leaveVillage().catch(() => {});
      api.logger.info("village: owner requested leave");
      ctx.villageCommandResult = "Left the village. Use /village join to rejoin.";
    } else if (text === "/village-join" || text === "/village join") {
      if (ctx.remoteState.botName) {
        ctx.villageCommandResult = "Already in the village.";
        return;
      }
      joinVillage().catch((err) => {
        api.logger.error(`village: join failed: ${err.message}`);
      });
      api.logger.info("village: owner requested join");
      ctx.villageCommandResult = "Joining the village now.\nObserve: https://ggbot.it.com/village/";
    }
  });
}
