import { generateKeyPairSync, createHash, createPrivateKey, sign } from "node:crypto";

export function generateDeviceIdentity() {
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

export function buildDeviceAuth({ deviceId, publicKeyB64Url, privateKeyPem, clientId, clientMode, role, scopes, token, nonce }) {
  const signedAtMs = Date.now();
  const payload = [
    "v2", deviceId, clientId, clientMode, role, scopes.join(","),
    String(signedAtMs), token || "", nonce,
  ].join("|");
  const signature = signPayload(privateKeyPem, payload);
  return { id: deviceId, publicKey: publicKeyB64Url, signature, signedAt: signedAtMs, nonce };
}
