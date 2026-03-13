import { buildDeviceAuth } from "./device-auth.js";

export function createGatewayRpc(deviceIdentity) {
  return function callGatewayRpc({ port, token, method, params, timeoutMs = 45_000 }) {
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
  };
}
