import { sleep } from "./helpers.js";

export function createPollLoop(ctx, hubRequest) {
  const { api } = ctx;

  function isTimeoutError(err) {
    return err.name === "TimeoutError" || err.message?.includes("aborted");
  }

  async function backoff(isError) {
    if (isError) {
      ctx.metrics.pollErrors++;
      await sleep(ctx.BACKOFF_MS);
    }
  }

  async function processSceneSafe(conversationId, payload) {
    const t0 = Date.now();
    try {
      const result = await ctx.remoteState.processScene(conversationId, payload);
      ctx.metrics.scenesProcessed++;
      ctx.metrics.sceneTotalMs += (Date.now() - t0);
      ctx.metrics.lastSceneAt = Date.now();
      return result;
    } catch (err) {
      ctx.metrics.scenesFailed++;
      ctx.metrics.sceneTotalMs += (Date.now() - t0);
      api.logger.warn(`village: processScene failed: ${err.message}`);
      return { actions: [{ tool: "village_observe", params: {} }] };
    }
  }

  async function pollLoop(signal) {
    while (!signal.aborted) {
      try {
        const { status, data } = await hubRequest(
          "GET", `/api/village/poll/${ctx.remoteState.botName}`, undefined, ctx.POLL_TIMEOUT_MS
        );

        if (signal.aborted) return "stopped";
        if (status === 409) return "superseded";
        if (status === 410) return "removed";
        if (status !== 200) { await backoff(status >= 400); continue; }

        const { requestId, conversationId: _locationId, ...v2Payload } = data;
        const villageSessionId = "plugin:village";
        const result = await processSceneSafe(villageSessionId, v2Payload);
        await hubRequest("POST", "/api/village/respond", { ...result, requestId }).catch(() => {});

      } catch (err) {
        if (signal.aborted) return "stopped";
        if (!isTimeoutError(err)) await backoff(true);
      }
    }
    return "stopped";
  }

  function startPolling() {
    if (ctx.remoteState.pollAbort) return;
    const ac = new AbortController();
    ctx.remoteState.pollAbort = ac;

    pollLoop(ac.signal).then((reason) => {
      if (ctx.remoteState.pollAbort === ac) ctx.remoteState.pollAbort = null;
      if (reason === "kicked") {
        api.logger.warn(`[village] state: IN_GAME → CONNECTED (kicked)`);
      } else if (reason === "superseded") {
        api.logger.warn("[village] state: IN_GAME → CONNECTED (superseded by newer connection)");
      } else if (reason === "removed") {
        api.logger.warn("[village] state: IN_GAME → CONNECTED (removed from game — send /village join to rejoin)");
        ctx.remoteState.botName = null;
      }
    });
  }

  function stopPolling() {
    if (ctx.remoteState.pollAbort) {
      ctx.remoteState.pollAbort.abort();
      ctx.remoteState.pollAbort = null;
    }
  }

  return { startPolling, stopPolling };
}
