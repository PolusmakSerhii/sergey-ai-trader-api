// Debug provider probes are intentionally disabled in all deployments.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).json({ ok: false, error: "Not found" });
}
