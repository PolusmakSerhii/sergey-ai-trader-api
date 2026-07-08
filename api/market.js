export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SOLUSDT").toUpperCase();

  const map = {
    SOLUSDT: "solana",
    BTCUSDT: "bitcoin",
    ETHUSDT: "ethereum",
    BNBUSDT: "binancecoin",
    RNDRUSDT: "render-token",
    TAOUSDT: "bittensor"
  };
  
  const id = map[symbol] || "solana";

  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`;

    const response = await fetch(url);
    const data = await response.json();
    const coin = data[0];
    const fg = await fetch("https://api.alternative.me/fng/?limit=1");
    const fgData = await fg.json();    
    res.status(200).json({
      ok: true,
      source: "CoinGecko Free API",
      symbol,
      coin: coin.name,
      asset: coin.symbol.toUpperCase(),
      rank: coin.market_cap_rank,
      
      fearGreed: {
  value: fgData.data[0].value,
  classification: fgData.data[0].value_classification
},   
      
      price: coin.current_price,
      change24h: coin.price_change_percentage_24h,
      high24h: coin.high_24h,
      low24h: coin.low_24h,
      volume24h: coin.total_volume,
      marketCap: coin.market_cap,
      circulatingSupply: coin.circulating_supply,
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
