export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOLUSDT").toUpperCase();
  const interval = req.query.interval || "1h";
  const limit = req.query.limit || "100";

  const base = "https://fapi.binance.com";

  try {
    const [ticker, funding, oi, depth, klines] = await Promise.all([
      fetch(`${base}/fapi/v1/ticker/24hr?symbol=${symbol}`).then(r => r.json()),
      fetch(`${base}/fapi/v1/premiumIndex?symbol=${symbol}`).then(r => r.json()),
      fetch(`${base}/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.json()),
      fetch(`${base}/fapi/v1/depth?symbol=${symbol}&limit=20`).then(r => r.json()),
      fetch(`${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`).then(r => r.json())
    ]);

    res.status(200).json({
      symbol,
      interval,
      source: "Binance Futures public API",
      timestamp: new Date().toISOString(),
      market: {
        price: Number(ticker.lastPrice),
        priceChangePercent24h: Number(ticker.priceChangePercent),
        high24h: Number(ticker.highPrice),
        low24h: Number(ticker.lowPrice),
        volume24h: Number(ticker.volume),
        quoteVolume24h: Number(ticker.quoteVolume)
      },
      funding: {
        markPrice: Number(funding.markPrice),
        indexPrice: Number(funding.indexPrice),
        lastFundingRate: Number(funding.lastFundingRate),
        nextFundingTime: funding.nextFundingTime
      },
      openInterest: {
        openInterest: Number(oi.openInterest)
      },
      orderBook: {
        bids: depth.bids,
        asks: depth.asks
      },
      candles: klines.map(k => ({
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5])
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
}
