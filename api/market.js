export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    message: "Sergey AI Trader API работает",
    symbol: req.query.symbol || "SOLUSDT",
    time: new Date().toISOString()
  });
}
