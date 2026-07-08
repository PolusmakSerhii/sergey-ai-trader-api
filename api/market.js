export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOLUSDT").toUpperCase();
  const interval = req.query.interval || "60";
  const limit = req.query.limit || "100";
  const base = "https://api.bybit.com";

  async function getJson(url) {
    const response = await fetch(url);
    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Источник вернул не JSON: " + text.slice(0, 120));
    }

    if (!response.ok || data.retCode !== 0) {
      throw new Error(JSON.stringify(data));
    }

    return data;
  }

  try {
    const ticker = await getJson(`${base}/v5/market/tickers?category=linear&symbol=${symbol}`);
    const orderbook = await getJson(`${base}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=25`);
    const klines = await getJson(`${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`);

    const t = ticker.result.list[0];

    res.status(200).json({
      ok: true,
      source: "Bybit Futures public API",
      symbol,
      price: Number(t.lastPrice),
      fundingRate: Number(t.fundingRate),
      openInterest: Number(t.openInterest),
      high24h: Number(t.highPrice24h),
      low24h: Number(t.lowPrice24h),
      volume24h: Number(t.volume24h),
      turnover24h: Number(t.turnover24h),
      orderBook: {
        bids: orderbook.result.b,
        asks: orderbook.result.a
      },
      candles: klines.result.list.map(k => ({
        startTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        turnover: Number(k[6])
      })),
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      symbol,
      error: error.message,
      time: new Date().toISOString()
    });
  }
}
