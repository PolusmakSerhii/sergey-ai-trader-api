export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOL-USDT").toUpperCase();

  const url = new URL(
    "https://www.okx.com/api/v5/market/candles"
  );

  url.searchParams.set("instId", symbol);
  url.searchParams.set("bar", "1D");
  url.searchParams.set("limit", "5");

  try {
    const response = await fetch(url);

    const data = await response
      .json()
      .catch(() => null);

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      status: response.status,
      requestedSymbol: symbol,
      source: "OKX",
      data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      source: "OKX",
      error: error.message
    });
  }
}
