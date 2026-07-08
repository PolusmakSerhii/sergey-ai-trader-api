function calculateRSI(prices, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

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
    
    const global = await fetch("https://api.coingecko.com/api/v3/global");
    const globalData = await global.json();
    const chart = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30`);
    const chartData = await chart.json();
    const prices = chartData.prices.map(p => p[1]);
    const rsi14 = calculateRSI(prices, 14);  
  
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
      
      btcDominance: Number(globalData.data.market_cap_percentage.btc.toFixed(2)),
      ethDominance: Number(globalData.data.market_cap_percentage.eth.toFixed(2)),
      technical: {
        rsi14
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
