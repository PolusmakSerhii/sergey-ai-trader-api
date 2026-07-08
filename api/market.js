async function binance(path) {
  const url = `https://fapi.binance.com${path}`;
  const response = await fetch(url);
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok || data?.code) {
    throw new Error(`${path} -> ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOLUSDT").toUpperCase();
  const interval = req.query.interval || "1h";
  const limit = Number(req.query.limit || 100);

  try {
    const ticker = await binance(`/fapi/v1/ticker/24hr?symbol=${symbol}`);
    const funding = await binance(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    const oi = await binance(`/fapi/v1/openInterest?symbol=${symbol}`);
    const depth = await binance(`/fapi/v1/depth?symbol=${symbol}&limit=20`);
    const klines = await binance(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);

    if (!Array.isArray(klines)) {
      throw new Error(`Klines response is not array: ${JSON.stringify(klines)}`);
    }

    res.status(200).json({
      ok: true,
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
        bestBid: depth.bids?.[0],
        bestAsk: depth.asks?.[0],
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
      ok: false,
      symbol,
      error: error.message
    });
  }
}
