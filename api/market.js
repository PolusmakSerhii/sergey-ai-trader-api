function getDailyCloses(prices) {
  if (!Array.isArray(prices)) return [];

  const days = {};

  for (const item of prices) {
    const date = new Date(item[0]).toISOString().slice(0, 10);
    days[date] = item[1];
  }

  return Object.values(days);
}

function calculateRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}
function calculateEMA(closes, period) {
  if (!closes || closes.length < period) return null;

  const k = 2 / (period + 1);

  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return Number(ema.toFixed(2));
}

function calculateMACD(closes) {
  if (!closes || closes.length < 35) return null;

  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  if (!ema12 || !ema26) return null;

  const macd = Number((ema12 - ema26).toFixed(4));

  return {
    macd
  };
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
    const chart = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=250`);    
    const chartData = await chart.json();
    const dailyCloses = getDailyCloses(chartData.prices);
    const rsi14 = calculateRSI(dailyCloses, 14);
    const ema20 = calculateEMA(dailyCloses, 20);
    const ema50 = calculateEMA(dailyCloses, 50);
    const ema100 = calculateEMA(dailyCloses, 100);
    const ema200 = calculateEMA(dailyCloses, 200);
    const macd = calculateMACD(dailyCloses);
    
   let trend = "Neutral";

if (ema20 && ema50 && ema100 && ema200) {
  if (
    coin.current_price > ema20 &&
    ema20 > ema50 &&
    ema50 > ema100 &&
    ema100 > ema200
  ) {
    trend = "Strong Bullish";
  } else if (
    coin.current_price < ema20 &&
    ema20 < ema50 &&
    ema50 < ema100 &&
    ema100 < ema200
  ) {
    trend = "Strong Bearish";
  }
}  
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
  rsi14,
  ema20,
  ema50,
  ema100,
  ema200,
  trend,
  macd
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
