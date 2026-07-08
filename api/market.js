export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOLUSDT").toUpperCase();
  const interval = req.query.interval || "60";
  const limit = req.query.limit || "100";

  const base = "https://api.bybit.com";

  try {
    const [tickerRes, orderbookRes, klineRes] = await Promise.all([
      fetch(`${base}/v5/market/tickers?category=linear&symbol=${symbol}`),
      fetch(`${base}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=25`),
      fetch(`${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`)
    ]);

    const ticker = await tickerRes.json();
    const orderbook = await orderbookRes.json();
    const klines = await klineRes.json();

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
      }))
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
