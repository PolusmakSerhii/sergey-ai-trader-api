import { createHash, timingSafeEqual } from "node:crypto";

export function privateApiSecret() {
  const secret = process.env.SM1M_API_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Private access is not configured");
  return secret;
}
export function privateBackendOrigin() {
  const url = new URL(process.env.SM1M_BACKEND_ORIGIN || "https://sergey-ai-trader-api.vercel.app");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid backend origin");
  return url.origin;
}
export function internalApiHeaders(origin) {
  if (new URL(origin).origin !== privateBackendOrigin()) throw new Error("Untrusted internal destination");
  return { Authorization: `Bearer ${privateApiSecret()}` };
}
export function requirePrivateApi(req, res, trustedRefresh = false) {
  res.setHeader("Cache-Control", "private, no-store");
  let expected;
  try { expected = privateApiSecret(); } catch {
    res.status(503).json({ ok: false, error: "Private access unavailable" }); return false;
  }
  if (trustedRefresh) return true; // Only the handler's verified QStash result, never a request header.
  const authorization = req.headers?.authorization;
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7) : "";
  const digest = value => createHash("sha256").update(value).digest();
  if (!supplied || supplied.length > 4096 || !timingSafeEqual(digest(supplied), digest(expected))) {
    res.status(401).json({ ok: false, error: "Unauthorized" }); return false;
  }
  return true;
}
