export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOLUSDT").toUpperCase();

  try {
    const url =
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true";

    const response = await fetch(url);
    const data = await response.json();

    res.status(200).json({
      ok: true,
      source: "CoinGecko Free API",
      symbol,
      asset: "SOL",
      price: data.solana.usd,
      change24h: data.solana.usd_24h_change,
      volume24h: data.solana.usd_24h_vol,
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
