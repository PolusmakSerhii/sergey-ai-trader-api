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
function calculateLevels(closes) {
  if (!closes || closes.length < 20) return null;

  const recent = closes.slice(-20);

  const support = Math.min(...recent);
  const resistance = Math.max(...recent);

  return {
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2))
  };
}

function calculateATR(ohlc, period = 14) {
  if (!Array.isArray(ohlc) || ohlc.length < period) return null;

  const recent = ohlc.slice(-period);

  if (!Array.isArray(recent) || recent.length === 0) return null;

  const ranges = recent.map(candle => {
    const high = candle[2];
    const low = candle[3];
    return high - low;
  });

  const atr = ranges.reduce((sum, value) => sum + value, 0) / period;

  return Number(atr.toFixed(2));
}

  const atr = ranges.reduce((sum, value) => sum + value, 0) / period;

  return Number(atr.toFixed(2));
}

function calculateVolumeStats(volumes) {
  if (!Array.isArray(volumes) || volumes.length < 20) return null;

  const recent = volumes.slice(-20);
  const sma20 = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const current = volumes[volumes.length - 1];

  const ratio = current / sma20;

  return {
    current: Math.round(current),
    sma20: Math.round(sma20),
    ratio: Number(ratio.toFixed(2)),
    spike: ratio >= 1.5
  };
}

function calculateSwingLevels(closes) {
  if (!Array.isArray(closes) || closes.length < 10) return null;

  const recent = closes.slice(-30);

  return {
    swingHigh: Number(Math.max(...recent).toFixed(2)),
    swingLow: Number(Math.min(...recent).toFixed(2))
  };
}

function calculateBOS(price, swings) {
  if (!swings) return "Unknown";

  if (price > swings.swingHigh)
    return "Bullish BOS";

  if (price < swings.swingLow)
    return "Bearish BOS";

  return "Inside Range";
}

function calculateCHOCH(bos, ema20, ema50) {
  if (bos === "Bullish BOS" && ema20 > ema50) {
    return "Bullish CHOCH";
  }

  if (bos === "Bearish BOS" && ema20 < ema50) {
    return "Bearish CHOCH";
  }

  return "No CHOCH";
}

function calculateLiquiditySweep(price, swings) {
  if (!swings) return "Unknown";

  if (price > swings.swingHigh * 0.998 && price < swings.swingHigh) {
    return "Above High Liquidity";
  }

  if (price < swings.swingLow * 1.002 && price > swings.swingLow) {
    return "Below Low Liquidity";
  }

  return "No Sweep";
}
function calculateFVG(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 3) return null;

  const gaps = [];

  for (let i = 2; i < ohlc.length; i++) {
    const candle1 = ohlc[i - 2];
    const candle3 = ohlc[i];

    const candle1High = candle1[2];
    const candle1Low = candle1[3];
    const candle3High = candle3[2];
    const candle3Low = candle3[3];

    if (candle1High < candle3Low) {
      gaps.push({
        type: "Bullish FVG",
        from: Number(candle1High.toFixed(2)),
        to: Number(candle3Low.toFixed(2))
      });
    }

    if (candle1Low > candle3High) {
      gaps.push({
        type: "Bearish FVG",
        from: Number(candle3High.toFixed(2)),
        to: Number(candle1Low.toFixed(2))
      });
    }
  }

  return gaps.slice(-3);
}
function calculateOrderBlocks(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 5) return null;

  const blocks = [];

  for (let i = 1; i < ohlc.length - 1; i++) {
    const prev = ohlc[i - 1];
    const current = ohlc[i];
    const next = ohlc[i + 1];

    const currentOpen = current[1];
    const currentHigh = current[2];
    const currentLow = current[3];
    const currentClose = current[4];

    const nextClose = next[4];

    if (currentClose < currentOpen && nextClose > currentHigh) {
      blocks.push({
        type: "Bullish Order Block",
        from: Number(currentLow.toFixed(2)),
        to: Number(currentHigh.toFixed(2))
      });
    }

    if (currentClose > currentOpen && nextClose < currentLow) {
      blocks.push({
        type: "Bearish Order Block",
        from: Number(currentLow.toFixed(2)),
        to: Number(currentHigh.toFixed(2))
      });
    }
  }

  return blocks.slice(-3);
}

function calculatePremiumDiscount(price, swings) {
  if (!swings) return null;

  const high = swings.swingHigh;
  const low = swings.swingLow;
  const equilibrium = (high + low) / 2;

  let zone = "Equilibrium";

  if (price > equilibrium) {
    zone = "Premium";
  }

  if (price < equilibrium) {
    zone = "Discount";
  }

  return {
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    equilibrium: Number(equilibrium.toFixed(2)),
    zone
  };
}

function calculateEqualHighLow(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 10) return null;

  const recent = ohlc.slice(-30);
  const tolerance = 0.003;

  const equalHighs = [];
  const equalLows = [];

  for (let i = 1; i < recent.length; i++) {
    const prevHigh = recent[i - 1][2];
    const currHigh = recent[i][2];

    const prevLow = recent[i - 1][3];
    const currLow = recent[i][3];

    if (Math.abs(prevHigh - currHigh) / prevHigh <= tolerance) {
      equalHighs.push(Number(currHigh.toFixed(2)));
    }

    if (Math.abs(prevLow - currLow) / prevLow <= tolerance) {
      equalLows.push(Number(currLow.toFixed(2)));
    }
  }

  return {
    equalHighs: equalHighs.slice(-3),
    equalLows: equalLows.slice(-3)
  };
}

function calculateImbalance(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 20) return null;

  const recent = ohlc.slice(-20);
  const last = recent[recent.length - 1];

  const open = last[1];
  const high = last[2];
  const low = last[3];
  const close = last[4];

  const body = Math.abs(close - open);
  const range = high - low;
  const bodyRatio = range === 0 ? 0 : body / range;

  let type = "No Imbalance";

  if (bodyRatio > 0.6 && close > open) {
    type = "Bullish Imbalance";
  }

  if (bodyRatio > 0.6 && close < open) {
    type = "Bearish Imbalance";
  }

  return {
    type,
    bodyRatio: Number(bodyRatio.toFixed(2)),
    candleRange: Number(range.toFixed(2))
  };
}
function calculateMSS(price, swings, bos, choch) {
  if (!swings) return null;

  let mss = "No MSS";

  if (
    price > swings.swingHigh &&
    (bos === "Bullish BOS" || choch === "Bullish CHOCH")
  ) {
    mss = "Bullish MSS";
  }

  if (
    price < swings.swingLow &&
    (bos === "Bearish BOS" || choch === "Bearish CHOCH")
  ) {
    mss = "Bearish MSS";
  }

  return mss;
}

function calculateProbabilityScore(data) {
  let score = 50;
  const reasons = [];

  if (data.trend === "Strong Bullish") {
    score += 15;
    reasons.push("Strong bullish trend");
  }

  if (data.trend === "Strong Bearish") {
    score -= 15;
    reasons.push("Strong bearish trend");
  }

  if (data.rsi14 && data.rsi14 < 30) {
    score += 10;
    reasons.push("RSI oversold");
  }

  if (data.rsi14 && data.rsi14 > 70) {
    score -= 10;
    reasons.push("RSI overbought");
  }

  if (data.macd && data.macd.macd > 0) {
    score += 8;
    reasons.push("MACD bullish");
  }

  if (data.macd && data.macd.macd < 0) {
    score -= 8;
    reasons.push("MACD bearish");
  }

  if (data.premiumDiscount?.zone === "Discount") {
    score += 10;
    reasons.push("Price in discount zone");
  }

  if (data.premiumDiscount?.zone === "Premium") {
    score -= 10;
    reasons.push("Price in premium zone");
  }

  if (data.bos === "Bullish BOS" || data.choch === "Bullish CHOCH" || data.mss === "Bullish MSS") {
    score += 12;
    reasons.push("Bullish market structure");
  }

  if (data.bos === "Bearish BOS" || data.choch === "Bearish CHOCH" || data.mss === "Bearish MSS") {
    score -= 12;
    reasons.push("Bearish market structure");
  }

  if (data.imbalance?.type === "Bullish Imbalance") {
    score += 8;
    reasons.push("Bullish imbalance");
  }

  if (data.imbalance?.type === "Bearish Imbalance") {
    score -= 8;
    reasons.push("Bearish imbalance");
  }

  score = Math.max(0, Math.min(100, score));

  let signal = "Neutral";

  if (score >= 80) signal = "Strong Buy";
  else if (score >= 65) signal = "Buy";
  else if (score <= 20) signal = "Strong Sell";
  else if (score <= 35) signal = "Sell";

  return {
    score,
    signal,
    reasons
  };
}

function calculateTradePlan(price, data) {
  const atr = data.atr14 || 0;
  const levels = data.levels;
  const probability = data.probability;

  if (!price || !levels || !probability) return null;

  let direction = "Wait";
  let entry = price;
  let stopLoss = null;
  let takeProfit = null;

  if (probability.signal === "Strong Buy" || probability.signal === "Buy") {
    direction = "Long";
    stopLoss = price - atr;
    takeProfit = levels.resistance;
  }

  if (probability.signal === "Strong Sell" || probability.signal === "Sell") {
    direction = "Short";
    stopLoss = price + atr;
    takeProfit = levels.support;
  }

  let riskReward = null;

  if (stopLoss && takeProfit) {
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    riskReward = risk === 0 ? null : Number((reward / risk).toFixed(2));
  }

  return {
    direction,
    entry: Number(entry.toFixed(2)),
    stopLoss: stopLoss ? Number(stopLoss.toFixed(2)) : null,
    takeProfit: takeProfit ? Number(takeProfit.toFixed(2)) : null,
    riskReward
  };
}
function calculateSmartMoneyScore(data) {
  let score = 50;
  const reasons = [];

  if (data.premiumDiscount?.zone === "Discount") {
    score += 12;
    reasons.push("Price in discount zone");
  }

  if (data.premiumDiscount?.zone === "Premium") {
    score -= 12;
    reasons.push("Price in premium zone");
  }

  if (Array.isArray(data.fvg) && data.fvg.some(g => g.type === "Bullish FVG")) {
    score += 10;
    reasons.push("Bullish FVG detected");
  }

  if (Array.isArray(data.fvg) && data.fvg.some(g => g.type === "Bearish FVG")) {
    score -= 10;
    reasons.push("Bearish FVG detected");
  }

  if (Array.isArray(data.orderBlocks) && data.orderBlocks.some(b => b.type === "Bullish Order Block")) {
    score += 10;
    reasons.push("Bullish order block detected");
  }

  if (Array.isArray(data.orderBlocks) && data.orderBlocks.some(b => b.type === "Bearish Order Block")) {
    score -= 10;
    reasons.push("Bearish order block detected");
  }

  if (data.liquiditySweep === "Below Low Liquidity") {
    score += 10;
    reasons.push("Sell-side liquidity sweep");
  }

  if (data.liquiditySweep === "Above High Liquidity") {
    score -= 10;
    reasons.push("Buy-side liquidity sweep");
  }

  if (data.bos === "Bullish BOS" || data.choch === "Bullish CHOCH" || data.mss === "Bullish MSS") {
    score += 12;
    reasons.push("Bullish structure");
  }

  if (data.bos === "Bearish BOS" || data.choch === "Bearish CHOCH" || data.mss === "Bearish MSS") {
    score -= 12;
    reasons.push("Bearish structure");
  }

  score = Math.max(0, Math.min(100, score));

  let rating = "Neutral";
  if (score >= 75) rating = "Bullish";
  if (score <= 25) rating = "Bearish";

  return {
    score,
    rating,
    reasons
  };
}

function calculateRecommendation(data) {
  const probability = data.probability;
  const smartMoney = data.smartMoney;

  if (!probability || !smartMoney) return null;

  let action = "Wait";
  let risk = "Medium";
  let confidence = Math.round((probability.score + smartMoney.score) / 2);

  if (probability.signal === "Strong Buy" && smartMoney.rating === "Bullish") {
    action = "Strong Buy";
    risk = "Low";
  } else if (probability.signal === "Buy" || smartMoney.rating === "Bullish") {
    action = "Buy";
    risk = "Medium";
  } else if (probability.signal === "Strong Sell" && smartMoney.rating === "Bearish") {
    action = "Strong Sell";
    risk = "Low";
  } else if (probability.signal === "Sell" || smartMoney.rating === "Bearish") {
    action = "Sell";
    risk = "Medium";
  }

  if (probability.signal === "Neutral" && smartMoney.rating === "Neutral") {
    action = "Wait";
    risk = "Medium";
  }
let description = `Signal: ${action}. Probability score: ${probability.score}/100. Smart Money score: ${smartMoney.score}/100. Better wait for stronger confirmation.`;

if (action === "Buy") {
  description = `Buy setup detected. Probability score: ${probability.score}/100. Smart Money score: ${smartMoney.score}/100. Bullish conditions are present, but confirmation is still recommended.`;
}

if (action === "Strong Buy") {
  description = `Strong Buy setup detected. Probability and Smart Money signals are aligned. Confidence: ${confidence}/100.`;
}

if (action === "Sell") {
  description = `Sell setup detected. Probability score: ${probability.score}/100. Smart Money score: ${smartMoney.score}/100. Bearish conditions are present, but confirmation is still recommended.`;
}

if (action === "Strong Sell") {
  description = `Strong Sell setup detected. Probability and Smart Money signals are aligned. Confidence: ${confidence}/100.`;
}
  
  return {
      action,
      confidence,
      risk,
      description
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
    const volumes = Array.isArray(chartData.total_volumes)
      ? chartData.total_volumes.map(v => v[1])
      : [];
    const ohlc = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=90`);
    const ohlcData = await ohlc.json();
    const dailyCloses = getDailyCloses(chartData.prices || []);    
    const rsi14 = calculateRSI(dailyCloses, 14);
    const ema20 = calculateEMA(dailyCloses, 20);
    const ema50 = calculateEMA(dailyCloses, 50);
    const ema100 = calculateEMA(dailyCloses, 100);
    const ema200 = calculateEMA(dailyCloses, 200);
    const macd = calculateMACD(dailyCloses);
    const levels = calculateLevels(dailyCloses);
    const atr14 = calculateATR(ohlcData, 14);
    const volumeStats = calculateVolumeStats(volumes);
    const swingLevels = calculateSwingLevels(dailyCloses);
    const bos = calculateBOS(coin.current_price, swingLevels);
    const choch = calculateCHOCH(bos, ema20, ema50);
    const liquiditySweep = calculateLiquiditySweep(
    coin.current_price,
    swingLevels
);
    const fvg = calculateFVG(ohlcData);
    const orderBlocks = calculateOrderBlocks(ohlcData);
    const premiumDiscount = calculatePremiumDiscount(
      coin.current_price,
      swingLevels
    );    
    const equalHighLow = calculateEqualHighLow(ohlcData);  
    const imbalance = calculateImbalance(ohlcData); 
    const mss = calculateMSS(
      coin.current_price,
      swingLevels,
      bos,
      choch
    );    
    
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
  const probability = calculateProbabilityScore({
    trend,
    rsi14,
    macd,
    premiumDiscount,
    bos,
    choch,
    mss,
    imbalance
});   
  const tradePlan = calculateTradePlan(coin.current_price, {
    atr14,
    levels,
    probability
  });    
 const smartMoney = calculateSmartMoneyScore({
   premiumDiscount,
   fvg,
   orderBlocks,
   liquiditySweep,
   bos,
   choch,
   mss
 }); 
const recommendation = calculateRecommendation({
  probability,
  smartMoney
});
    
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
    macd,
    levels,
    atr14,
    volumeStats,
    swingLevels,
    bos,
    choch,
    liquiditySweep,
    fvg,
    orderBlocks,
    premiumDiscount,
    equalHighLow,
    imbalance,
    mss,
    probability,
    tradePlan,
    smartMoney,
    recommendation
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
