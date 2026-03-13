export const ALLOWED_PREFIXES = ["village_", "survival_", "game_", "dnd_"];
export const MAX_PARAM_LENGTH = 500;

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function isAllowedToolName(name) {
  return typeof name === "string" && ALLOWED_PREFIXES.some(p => name.startsWith(p));
}

export function isVillageSession(sessionKey) {
  if (typeof sessionKey !== "string") return false;
  return sessionKey.includes(":village:") || sessionKey.endsWith(":village")
      || sessionKey.includes(":survival:") || sessionKey.endsWith(":survival");
}

export function isDmSession(sessionKey) {
  if (typeof sessionKey !== "string") return false;
  return !sessionKey.includes(":group:") && !isVillageSession(sessionKey);
}

export function sanitize(text, maxLen = MAX_PARAM_LENGTH) {
  if (typeof text !== "string") return "";
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLen);
}

export function extractConversationNonce(sessionKey) {
  if (!sessionKey) return null;
  const prefix = "agent:main:";
  if (sessionKey.startsWith(prefix)) return sessionKey.slice(prefix.length);
  let idx = sessionKey.indexOf(":village:");
  if (idx === -1) idx = sessionKey.indexOf(":village");
  if (idx === -1) idx = sessionKey.indexOf(":survival:");
  if (idx === -1) idx = sessionKey.indexOf(":survival");
  if (idx === -1) return null;
  return sessionKey.slice(idx + 1);
}

export function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

export function resolvePending(pending, key) {
  const entry = pending.get(key);
  if (entry) {
    entry.resolve(entry);
    pending.delete(key);
  }
}
