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
  let longScore = 0;
  let shortScore = 0;

  const longReasons = [];
  const shortReasons = [];

  const fvg = Array.isArray(data.fvg) ? data.fvg : [];
  const orderBlocks = Array.isArray(data.orderBlocks)
    ? data.orderBlocks
    : [];

  const equalHighs = Array.isArray(data.equalHighLow?.equalHighs)
    ? data.equalHighLow.equalHighs
    : [];

  const equalLows = Array.isArray(data.equalHighLow?.equalLows)
    ? data.equalHighLow.equalLows
    : [];

  const macdValue =
    typeof data.macd?.macd === "number"
      ? data.macd.macd
      : 0;

  // TREND
  if (data.trend === "Strong Bullish") {
    longScore += 18;
    longReasons.push("Strong bullish trend");
  }

  if (data.trend === "Strong Bearish") {
    shortScore += 18;
    shortReasons.push("Strong bearish trend");
  }

  // RSI
  if (typeof data.rsi14 === "number") {
    if (data.rsi14 < 30) {
      longScore += 10;
      longReasons.push("RSI oversold");
    }

    if (data.rsi14 > 70) {
      shortScore += 10;
      shortReasons.push("RSI overbought");
    }

    if (data.rsi14 >= 50 && data.rsi14 <= 65) {
      longScore += 4;
      longReasons.push("RSI bullish momentum");
    }

    if (data.rsi14 >= 35 && data.rsi14 < 50) {
      shortScore += 4;
      shortReasons.push("RSI bearish momentum");
    }
  }

  // MACD
  if (macdValue > 0) {
    longScore += 10;
    longReasons.push("MACD bullish");
  }

  if (macdValue < 0) {
    shortScore += 10;
    shortReasons.push("MACD bearish");
  }

  // PREMIUM / DISCOUNT
  if (data.premiumDiscount?.zone === "Discount") {
    longScore += 8;
    longReasons.push("Price in discount zone");
  }

  if (data.premiumDiscount?.zone === "Premium") {
    shortScore += 8;
    shortReasons.push("Price in premium zone");
  }

  // BOS
  if (data.bos === "Bullish BOS") {
    longScore += 8;
    longReasons.push("Bullish BOS");
  }

  if (data.bos === "Bearish BOS") {
    shortScore += 8;
    shortReasons.push("Bearish BOS");
  }

  // CHOCH
  if (data.choch === "Bullish CHOCH") {
    longScore += 10;
    longReasons.push("Bullish CHOCH");
  }

  if (data.choch === "Bearish CHOCH") {
    shortScore += 10;
    shortReasons.push("Bearish CHOCH");
  }

  // MSS
  if (data.mss === "Bullish MSS") {
    longScore += 10;
    longReasons.push("Bullish MSS");
  }

  if (data.mss === "Bearish MSS") {
    shortScore += 10;
    shortReasons.push("Bearish MSS");
  }

  // LIQUIDITY SWEEP
  if (data.liquiditySweep === "Below Low Liquidity") {
    longScore += 8;
    longReasons.push("Sell-side liquidity sweep");
  }

  if (data.liquiditySweep === "Above High Liquidity") {
    shortScore += 8;
    shortReasons.push("Buy-side liquidity sweep");
  }

  // FVG
  if (fvg.some(item => item?.type === "Bullish FVG")) {
    longScore += 8;
    longReasons.push("Bullish FVG");
  }

  if (fvg.some(item => item?.type === "Bearish FVG")) {
    shortScore += 8;
    shortReasons.push("Bearish FVG");
  }

  // ORDER BLOCKS
  if (
    orderBlocks.some(
      item => item?.type === "Bullish Order Block"
    )
  ) {
    longScore += 12;
    longReasons.push("Bullish Order Block");
  }

  if (
    orderBlocks.some(
      item => item?.type === "Bearish Order Block"
    )
  ) {
    shortScore += 12;
    shortReasons.push("Bearish Order Block");
  }

  // EQUAL HIGHS / LOWS
  if (equalHighs.length > 0) {
    shortScore += 5;
    shortReasons.push("Equal highs liquidity");
  }

  if (equalLows.length > 0) {
    longScore += 5;
    longReasons.push("Equal lows liquidity");
  }

  // IMBALANCE
  if (data.imbalance?.type === "Bullish Imbalance") {
    longScore += 6;
    longReasons.push("Bullish imbalance");
  }

  if (data.imbalance?.type === "Bearish Imbalance") {
    shortScore += 6;
    shortReasons.push("Bearish imbalance");
  }

  longScore = Math.min(100, longScore);
  shortScore = Math.min(100, shortScore);

  const score = Math.max(longScore, shortScore);
  const scoreDifference = Math.abs(longScore - shortScore);

  let signal = "Neutral";
  let direction = "Neutral";
  let reasons = [];

  if (longScore >= 70 && longScore > shortScore) {
    signal = "Strong Buy";
    direction = "Long";
    reasons = longReasons;
  } else if (
    longScore >= 55 &&
    longScore > shortScore &&
    scoreDifference >= 8
  ) {
    signal = "Buy";
    direction = "Long";
    reasons = longReasons;
  } else if (shortScore >= 70 && shortScore > longScore) {
    signal = "Strong Sell";
    direction = "Short";
    reasons = shortReasons;
  } else if (
    shortScore >= 55 &&
    shortScore > longScore &&
    scoreDifference >= 8
  ) {
    signal = "Sell";
    direction = "Short";
    reasons = shortReasons;
  } else {
    reasons = [
      ...longReasons.map(reason => `Bullish: ${reason}`),
      ...shortReasons.map(reason => `Bearish: ${reason}`)
    ];
  }

  return {
    score,
    signal,
    direction,
    longScore,
    shortScore,
    scoreDifference,
    reasons
  };
}

function calculateTradePlan(price, data) {
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    !data
  ) {
    return null;
  }

  const atr = Number(data.atr14) || 0;
  const safeAtr = atr > 0 ? atr : price * 0.02;

  const probability = data.probability || {};
  const smartMoney = data.smartMoney || {};
  const levels = data.levels || {};

  const macdValue =
    typeof data.macd?.macd === "number"
      ? data.macd.macd
      : 0;

  const fvg = Array.isArray(data.fvg) ? data.fvg : [];
  const orderBlocks = Array.isArray(data.orderBlocks)
    ? data.orderBlocks
    : [];

  let longScore = 0;
  let shortScore = 0;

  const longReasons = [];
  const shortReasons = [];

  // 1. Probability
  if (probability.signal === "Strong Buy") {
    longScore += 30;
    longReasons.push("Strong Buy probability");
  } else if (probability.signal === "Buy") {
    longScore += 20;
    longReasons.push("Buy probability");
  }

  if (probability.signal === "Strong Sell") {
    shortScore += 30;
    shortReasons.push("Strong Sell probability");
  } else if (probability.signal === "Sell") {
    shortScore += 20;
    shortReasons.push("Sell probability");
  }

  // 2. Smart Money
  if (smartMoney.rating === "Bullish") {
    longScore += 15;
    longReasons.push("Bullish Smart Money");
  }

  if (smartMoney.rating === "Bearish") {
    shortScore += 15;
    shortReasons.push("Bearish Smart Money");
  }

  if (
    typeof smartMoney.score === "number" &&
    smartMoney.score >= 60
  ) {
    longScore += 8;
    longReasons.push("Smart Money score above 60");
  }

  if (
    typeof smartMoney.score === "number" &&
    smartMoney.score <= 40
  ) {
    shortScore += 8;
    shortReasons.push("Smart Money score below 40");
  }

  // 3. Trend
  if (data.trend === "Strong Bullish") {
    longScore += 15;
    longReasons.push("Strong bullish trend");
  }

  if (data.trend === "Strong Bearish") {
    shortScore += 15;
    shortReasons.push("Strong bearish trend");
  }

  // 4. MACD
  if (macdValue > 0) {
    longScore += 8;
    longReasons.push("MACD bullish");
  }

  if (macdValue < 0) {
    shortScore += 8;
    shortReasons.push("MACD bearish");
  }

  // 5. Premium / Discount
  if (data.premiumDiscount?.zone === "Discount") {
    longScore += 10;
    longReasons.push("Price in discount zone");
  }

  if (data.premiumDiscount?.zone === "Premium") {
    shortScore += 10;
    shortReasons.push("Price in premium zone");
  }

  // 6. Market structure
  if (
    data.bos === "Bullish BOS" ||
    data.choch === "Bullish CHOCH" ||
    data.mss === "Bullish MSS"
  ) {
    longScore += 12;
    longReasons.push("Bullish market structure");
  }

  if (
    data.bos === "Bearish BOS" ||
    data.choch === "Bearish CHOCH" ||
    data.mss === "Bearish MSS"
  ) {
    shortScore += 12;
    shortReasons.push("Bearish market structure");
  }

  // 7. Liquidity Sweep
  if (data.liquiditySweep === "Below Low Liquidity") {
    longScore += 10;
    longReasons.push("Sell-side liquidity sweep");
  }

  if (data.liquiditySweep === "Above High Liquidity") {
    shortScore += 10;
    shortReasons.push("Buy-side liquidity sweep");
  }

  // 8. FVG
  if (fvg.some(item => item?.type === "Bullish FVG")) {
    longScore += 6;
    longReasons.push("Bullish FVG");
  }

  if (fvg.some(item => item?.type === "Bearish FVG")) {
    shortScore += 6;
    shortReasons.push("Bearish FVG");
  }

  // 9. Order Blocks
  if (
    orderBlocks.some(
      item => item?.type === "Bullish Order Block"
    )
  ) {
    longScore += 6;
    longReasons.push("Bullish Order Block");
  }

  if (
    orderBlocks.some(
      item => item?.type === "Bearish Order Block"
    )
  ) {
    shortScore += 6;
    shortReasons.push("Bearish Order Block");
  }

  // 10. Imbalance
  if (data.imbalance?.type === "Bullish Imbalance") {
    longScore += 8;
    longReasons.push("Bullish imbalance");
  }

  if (data.imbalance?.type === "Bearish Imbalance") {
    shortScore += 8;
    shortReasons.push("Bearish imbalance");
  }

  longScore = Math.min(100, longScore);
  shortScore = Math.min(100, shortScore);

  const minimumSetupScore = 45;
  const minimumScoreDifference = 8;

  let candidateDirection = "Wait";
  let setupScore = Math.max(longScore, shortScore);
  let reasons = [];

  if (
    longScore >= minimumSetupScore &&
    longScore - shortScore >= minimumScoreDifference
  ) {
    candidateDirection = "Long";
    setupScore = longScore;
    reasons = longReasons;
  }

  if (
    shortScore >= minimumSetupScore &&
    shortScore - longScore >= minimumScoreDifference
  ) {
    candidateDirection = "Short";
    setupScore = shortScore;
    reasons = shortReasons;
  }

  if (candidateDirection === "Wait") {
    return {
      direction: "Wait",
      candidateDirection: "Wait",
      status: "No Confirmed Setup",
      validTrade: false,

      rejectionReason:
        longScore < minimumSetupScore &&
        shortScore < minimumSetupScore
          ? "Setup score is below minimum threshold"
          : "Bullish and bearish signals conflict",

      minimumSetupScore,
      minimumScoreDifference,

      longScore,
      shortScore,
      setupScore,

      reasons: [],

      entry: Number(price.toFixed(2)),
      entryZone: null,
      stopLoss: null,

      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,

      structuralTarget: null,

      riskReward: null,

      riskRewardByTarget: {
        takeProfit1: null,
        takeProfit2: null,
        takeProfit3: null,
        structuralTarget: null
      },

      recommendedTakeProfit: null
    };
  }

  const entry = price;

  let entryZoneFrom;
  let entryZoneTo;
  let stopLoss;
  let takeProfit1;
  let takeProfit2;
  let takeProfit3;
  let structuralTarget = null;

  if (candidateDirection === "Long") {
    entryZoneFrom = entry - safeAtr * 0.25;
    entryZoneTo = entry + safeAtr * 0.1;

    stopLoss = entry - safeAtr;

    takeProfit1 = entry + safeAtr;
    takeProfit2 = entry + safeAtr * 2;
    takeProfit3 = entry + safeAtr * 3;

    if (
      typeof levels.resistance === "number" &&
      levels.resistance > entry
    ) {
      structuralTarget = levels.resistance;
    }
  }

  if (candidateDirection === "Short") {
    entryZoneFrom = entry - safeAtr * 0.1;
    entryZoneTo = entry + safeAtr * 0.25;

    stopLoss = entry + safeAtr;

    takeProfit1 = entry - safeAtr;
    takeProfit2 = entry - safeAtr * 2;
    takeProfit3 = entry - safeAtr * 3;

    if (
      typeof levels.support === "number" &&
      levels.support < entry
    ) {
      structuralTarget = levels.support;
    }
  }

  const risk = Math.abs(entry - stopLoss);

  function calculateRiskReward(target) {
    if (
      typeof target !== "number" ||
      !Number.isFinite(target) ||
      risk === 0
    ) {
      return null;
    }

    return Number(
      (Math.abs(target - entry) / risk).toFixed(2)
    );
  }

  const riskReward1 = calculateRiskReward(takeProfit1);
  const riskReward2 = calculateRiskReward(takeProfit2);
  const riskReward3 = calculateRiskReward(takeProfit3);

  const structuralRiskReward =
    calculateRiskReward(structuralTarget);

  const minimumRiskReward = 1.5;

  const validTrade =
    setupScore >= minimumSetupScore &&
    riskReward2 !== null &&
    riskReward2 >= minimumRiskReward;

  return {
    direction: validTrade
      ? candidateDirection
      : "Wait",

    candidateDirection,

    status: validTrade
      ? "Valid Trade"
      : "Rejected",

    validTrade,

    rejectionReason: validTrade
      ? null
      : `Risk/Reward is below ${minimumRiskReward}`,

    minimumSetupScore,
    minimumScoreDifference,
    minimumRiskReward,

    longScore,
    shortScore,
    setupScore,

    confidence: setupScore,
    reasons,

    entry: Number(entry.toFixed(2)),

    entryZone: {
      from: Number(entryZoneFrom.toFixed(2)),
      to: Number(entryZoneTo.toFixed(2))
    },

    stopLoss: Number(stopLoss.toFixed(2)),

    takeProfit1: Number(takeProfit1.toFixed(2)),
    takeProfit2: Number(takeProfit2.toFixed(2)),
    takeProfit3: Number(takeProfit3.toFixed(2)),

    structuralTarget:
      structuralTarget !== null
        ? Number(structuralTarget.toFixed(2))
        : null,

    riskReward: riskReward2,

    riskRewardByTarget: {
      takeProfit1: riskReward1,
      takeProfit2: riskReward2,
      takeProfit3: riskReward3,
      structuralTarget: structuralRiskReward
    },

    recommendedTakeProfit: {
      target: "takeProfit2",
      price: Number(takeProfit2.toFixed(2)),
      riskReward: riskReward2
    }
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
  const probability = data?.probability;
  const smartMoney = data?.smartMoney;
  const tradePlan = data?.tradePlan;

  if (!probability || !smartMoney || !tradePlan) {
    return null;
  }

  const probabilityScore =
    typeof probability.score === "number"
      ? probability.score
      : 0;

  const smartMoneyScore =
    typeof smartMoney.score === "number"
      ? smartMoney.score
      : 50;

  const setupScore =
    typeof tradePlan.setupScore === "number"
      ? tradePlan.setupScore
      : 0;

  let trendScore = 50;

  if (
    data.trend === "Strong Bullish" ||
    data.trend === "Strong Bearish"
  ) {
    trendScore = 80;
  }

  const confidence = Math.round(
    probabilityScore * 0.3 +
    smartMoneyScore * 0.2 +
    setupScore * 0.4 +
    trendScore * 0.1
  );
const riskReward =
  typeof tradePlan.riskReward === "number"
    ? tradePlan.riskReward
    : 0;

let riskRewardScore = 0;

if (riskReward >= 3) {
  riskRewardScore = 100;
} else if (riskReward >= 2) {
  riskRewardScore = 85;
} else if (riskReward >= 1.5) {
  riskRewardScore = 70;
} else if (riskReward > 0) {
  riskRewardScore = 40;
}

const gradeScore = Math.round(
  probabilityScore * 0.25 +
  smartMoneyScore * 0.2 +
  setupScore * 0.35 +
  riskRewardScore * 0.2
);

let grade = "D";

if (tradePlan.validTrade) {
  if (gradeScore >= 85) {
    grade = "A+";
  } else if (gradeScore >= 75) {
    grade = "A";
  } else if (gradeScore >= 65) {
    grade = "B";
  } else if (gradeScore >= 55) {
    grade = "C";
  }
}
let setupQuality = {
  stars: 1,
  label: "Avoid"
};

if (tradePlan.validTrade) {
  if (gradeScore >= 85) {
    setupQuality = {
      stars: 5,
      label: "Excellent"
    };
  } else if (gradeScore >= 75) {
    setupQuality = {
      stars: 4,
      label: "Very Good"
    };
  } else if (gradeScore >= 65) {
    setupQuality = {
      stars: 3,
      label: "Good"
    };
  } else if (gradeScore >= 55) {
    setupQuality = {
      stars: 2,
      label: "Average"
    };
  } else {
    setupQuality = {
      stars: 1,
      label: "Weak"
    };
  }
}  
  
let entryTiming = {
  status: "Wait Confirmation",
  priority: "Low",
  instruction: "Do not enter until a valid setup appears"
};
  
if (tradePlan.validTrade) {
  const scoreDifference =
    typeof probability.scoreDifference === "number"
      ? probability.scoreDifference
      : 0;

  if (
    confidence >= 75 &&
    scoreDifference >= 20
  ) {
    entryTiming = {
      status: "Execute in Entry Zone",
      priority: "High",
      instruction: `Entry is allowed only between ${tradePlan.entryZone?.from ?? "N/A"} and ${tradePlan.entryZone?.to ?? "N/A"}`
    };
  } else if (
    confidence >= 60 &&
    scoreDifference >= 8
  ) {
    entryTiming = {
      status: "Wait Pullback",
      priority: "Medium",
      instruction: `Wait for price to return to the entry zone ${tradePlan.entryZone?.from ?? "N/A"} - ${tradePlan.entryZone?.to ?? "N/A"}`
    };
  } else {
    entryTiming = {
  status: "Wait Confirmation",
  priority: "Low",
  instruction: "Wait for stronger confirmation before entering"
};
  }
}
 let positionSize = {
  riskPercent: 0,
  leverage: "No Trade",
  comment: "Do not open a position"
 };
  
if (tradePlan.validTrade) {

  if (grade === "A+") {
    positionSize = {
      riskPercent: 2,
      leverage: "5x-10x"
    };
  }

  else if (grade === "A") {
    positionSize = {
      riskPercent: 1.5,
      leverage: "3x-8x"
    };
  }

  else if (grade === "B") {
    positionSize = {
      riskPercent: 1,
      leverage: "3x-5x"
    };
  }

  else if (grade === "C") {
    positionSize = {
      riskPercent: 0.5,
      leverage: "2x-3x"
    };
  }

}
  let action = "Wait";
  let status = "No Trade";
  let risk = "High";

  if (
    tradePlan.validTrade &&
    tradePlan.direction === "Long"
  ) {
    action = confidence >= 75 ? "Strong Buy" : "Buy";
    status = "Valid Long Setup";
    risk = confidence >= 75 ? "Low" : "Medium";
  }

  if (
    tradePlan.validTrade &&
    tradePlan.direction === "Short"
  ) {
    action = confidence >= 75 ? "Strong Sell" : "Sell";
    status = "Valid Short Setup";
    risk = confidence >= 75 ? "Low" : "Medium";
  }

  const description =
    tradePlan.validTrade
      ? `${status}. Confidence: ${confidence}/100. Entry zone: ${tradePlan.entryZone?.from ?? "N/A"} - ${tradePlan.entryZone?.to ?? "N/A"}. Stop Loss: ${tradePlan.stopLoss ?? "N/A"}. TP1: ${tradePlan.takeProfit1 ?? "N/A"}. TP2: ${tradePlan.takeProfit2 ?? "N/A"}. TP3: ${tradePlan.takeProfit3 ?? "N/A"}. Recommended target: ${tradePlan.recommendedTakeProfit?.target || "N/A"} at ${tradePlan.recommendedTakeProfit?.price ?? "N/A"}. Risk/Reward: ${tradePlan.riskReward !== null && tradePlan.riskReward !== undefined ? `1:${tradePlan.riskReward}` : "N/A"}.`
      : `No Trade. ${tradePlan.rejectionReason || "No confirmed setup"}. Probability: ${probabilityScore}/100. Smart Money: ${smartMoneyScore}/100.`;

    return {
      action,
      status,
      confidence,
      grade,
      gradeScore,
      setupQuality,
      entryTiming,
      positionSize,
      risk,

     direction: tradePlan.direction,
     validTrade: tradePlan.validTrade,  
      
    entryZone: tradePlan.entryZone,
    stopLoss: tradePlan.stopLoss,

    takeProfit1: tradePlan.takeProfit1,
    takeProfit2: tradePlan.takeProfit2,
    takeProfit3: tradePlan.takeProfit3,

    recommendedTakeProfit:
      tradePlan.recommendedTakeProfit,

    riskReward: tradePlan.riskReward,

    reasons: Array.isArray(tradePlan.reasons)
      ? tradePlan.reasons
      : [],

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

if (!response.ok) {
  throw new Error(`CoinGecko request failed: ${response.status}`);
}

if (!Array.isArray(data) || data.length === 0) {
  throw new Error(`No market data returned for ${symbol}`);
}

   const coin = data[0];

if (!coin || typeof coin.current_price !== "number") {
  throw new Error(`Invalid market data for ${symbol}`);
}    
    
    const fg = await fetch("https://api.alternative.me/fng/?limit=1");
    const fgData = await fg.json(); 
    
    const global = await fetch("https://api.coingecko.com/api/v3/global");
    const globalData = await global.json();
    const marketCapPercentage = globalData?.data?.market_cap_percentage || {};
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
    imbalance,
    liquiditySweep,
    fvg,
    orderBlocks,
    equalHighLow
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

  const tradePlan = calculateTradePlan(coin.current_price, {
    atr14,
    levels,
    probability,
    smartMoney,
    trend,
    macd,
    premiumDiscount,
    bos,
    choch,
    mss,
    liquiditySweep,
    fvg,
    orderBlocks,
    imbalance
  });
    
 const recommendation = calculateRecommendation({
  probability,
  smartMoney,
  tradePlan,
  trend,
  macd,
  premiumDiscount
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
      
btcDominance:
  typeof marketCapPercentage.btc === "number"
    ? Number(marketCapPercentage.btc.toFixed(2))
    : null,

ethDominance:
  typeof marketCapPercentage.eth === "number"
    ? Number(marketCapPercentage.eth.toFixed(2))
    : null,
      
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
