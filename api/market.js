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

function calculateEMASeries(closes, period) {
  if (
    !Array.isArray(closes) ||
    closes.length < period
  ) {
    return [];
  }

  const multiplier = 2 / (period + 1);

  const initialSma =
    closes
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  const result = new Array(period - 1).fill(null);

  let previousEma = initialSma;
  result.push(previousEma);

  for (let i = period; i < closes.length; i++) {
    previousEma =
      closes[i] * multiplier +
      previousEma * (1 - multiplier);

    result.push(previousEma);
  }

  return result;
}

function calculateMACD(
  closes,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  if (
    !Array.isArray(closes) ||
    closes.length <
      slowPeriod + signalPeriod
  ) {
    return null;
  }

  const fastEmaSeries =
    calculateEMASeries(closes, fastPeriod);

  const slowEmaSeries =
    calculateEMASeries(closes, slowPeriod);

  const macdSeries = [];

  for (let i = 0; i < closes.length; i++) {
    const fast = fastEmaSeries[i];
    const slow = slowEmaSeries[i];

    if (
      typeof fast === "number" &&
      typeof slow === "number"
    ) {
      macdSeries.push(fast - slow);
    }
  }

  if (macdSeries.length < signalPeriod) {
    return null;
  }

  const signalSeries =
    calculateEMASeries(
      macdSeries,
      signalPeriod
    );

  const macdLine =
    macdSeries[macdSeries.length - 1];

  const signalLine =
    signalSeries[signalSeries.length - 1];

  if (
    typeof macdLine !== "number" ||
    typeof signalLine !== "number"
  ) {
    return null;
  }

  const histogram = macdLine - signalLine;

  return {
    macd: Number(macdLine.toFixed(4)),
    signal: Number(signalLine.toFixed(4)),
    histogram: Number(histogram.toFixed(4)),
    trend:
      histogram > 0
        ? "Bullish"
        : histogram < 0
          ? "Bearish"
          : "Neutral"
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
  const warnings = [];

  const price =
    typeof data.price === "number" &&
    Number.isFinite(data.price)
      ? data.price
      : null;

  const fvg = Array.isArray(data.fvg)
    ? data.fvg
    : [];

  const orderBlocks = Array.isArray(data.orderBlocks)
    ? data.orderBlocks
    : [];

  const equalHighs = Array.isArray(
    data.equalHighLow?.equalHighs
  )
    ? data.equalHighLow.equalHighs
    : [];

  const equalLows = Array.isArray(
    data.equalHighLow?.equalLows
  )
    ? data.equalHighLow.equalLows
    : [];

  const macdValue =
    typeof data.macd?.macd === "number"
      ? data.macd.macd
      : 0;
const coinGlass = data.coinGlass || {};

const fundingRate =
  typeof coinGlass.fundingRate?.rate === "number"
    ? coinGlass.fundingRate.rate
    : null;

const openInterest = coinGlass.openInterest || {};

const openInterestChange1h =
  typeof openInterest.change1h === "number"
    ? openInterest.change1h
    : null;

const openInterestChange4h =
  typeof openInterest.change4h === "number"
    ? openInterest.change4h
    : null;

const openInterestChange24h =
  typeof openInterest.change24h === "number"
    ? openInterest.change24h
    : null;

const longAccount =
  typeof coinGlass.longShortRatio?.longAccount === "number"
    ? coinGlass.longShortRatio.longAccount
    : null;

const shortAccount =
  typeof coinGlass.longShortRatio?.shortAccount === "number"
    ? coinGlass.longShortRatio.shortAccount
    : null;

const longShortRatio =
  typeof coinGlass.longShortRatio?.ratio === "number"
    ? coinGlass.longShortRatio.ratio
    : null;

const priceChange24h =
  typeof data.change24h === "number"
    ? data.change24h
    : null;
   
const volumeStats = data.volumeStats || {};

const volumeRatio =
  typeof volumeStats.ratio === "number"
    ? volumeStats.ratio
    : null;

const volumeSpike =
  volumeStats.spike === true;
   
const liquidations = Array.isArray(
  coinGlass.liquidations
)
  ? coinGlass.liquidations
  : [];

const totalLiquidations =
  liquidations.find(
    item => item?.exchange === "All"
  ) || null;

const longLiquidations =
  typeof totalLiquidations?.longLiquidation_usd === "number"
    ? totalLiquidations.longLiquidation_usd
    : null;

const shortLiquidations =
  typeof totalLiquidations?.shortLiquidation_usd === "number"
    ? totalLiquidations.shortLiquidation_usd
    : null;   

  function isPriceNearLevel(
    level,
    tolerancePercent = 1.5
  ) {
    if (
      price === null ||
      typeof level !== "number" ||
      !Number.isFinite(level)
    ) {
      return false;
    }

    const distancePercent =
      Math.abs(price - level) / price * 100;

    return distancePercent <= tolerancePercent;
  }

  function isPriceNearZone(
    zone,
    tolerancePercent = 2
  ) {
    if (
      price === null ||
      !zone ||
      typeof zone.from !== "number" ||
      typeof zone.to !== "number"
    ) {
      return false;
    }

    const low = Math.min(zone.from, zone.to);
    const high = Math.max(zone.from, zone.to);

    const tolerance = price * (
      tolerancePercent / 100
    );

    return (
      price >= low - tolerance &&
      price <= high + tolerance
    );
  }

  // 1. TREND — максимум 20 баллов
  if (data.trend === "Strong Bullish") {
    longScore += 20;
    longReasons.push(
      "Strong bullish EMA trend"
    );
  } else if (data.trend === "Strong Bearish") {
    shortScore += 20;
    shortReasons.push(
      "Strong bearish EMA trend"
    );
  } else {
    warnings.push(
      "EMA trend is neutral or mixed"
    );
  }

  // 2. RSI — максимум 8 баллов
  if (typeof data.rsi14 === "number") {
    if (data.rsi14 <= 30) {
      longScore += 8;
      longReasons.push("RSI oversold");
    } else if (data.rsi14 >= 70) {
      shortScore += 8;
      shortReasons.push("RSI overbought");
    } else if (
      data.rsi14 >= 52 &&
      data.rsi14 <= 65
    ) {
      longScore += 4;
      longReasons.push(
        "RSI confirms bullish momentum"
      );
    } else if (
      data.rsi14 >= 35 &&
      data.rsi14 <= 48
    ) {
      shortScore += 4;
      shortReasons.push(
        "RSI confirms bearish momentum"
      );
    }
  }

  // 3. MACD — максимум 8 баллов
  if (macdValue > 0) {
    longScore += 8;
    longReasons.push("MACD above zero");
  } else if (macdValue < 0) {
    shortScore += 8;
    shortReasons.push("MACD below zero");
  }

  // 4. PREMIUM / DISCOUNT — максимум 8 баллов
  if (data.premiumDiscount?.zone === "Discount") {
    longScore += 8;
    longReasons.push(
      "Price is in discount zone"
    );
  } else if (
    data.premiumDiscount?.zone === "Premium"
  ) {
    shortScore += 8;
    shortReasons.push(
      "Price is in premium zone"
    );
  }

  // 5. BOS — максимум 12 баллов
  if (data.bos === "Bullish BOS") {
    longScore += 12;
    longReasons.push(
      "Bullish break of structure"
    );
  } else if (data.bos === "Bearish BOS") {
    shortScore += 12;
    shortReasons.push(
      "Bearish break of structure"
    );
  }

  // 6. CHOCH — максимум 14 баллов
  if (data.choch === "Bullish CHOCH") {
    longScore += 14;
    longReasons.push(
      "Bullish change of character"
    );
  } else if (
    data.choch === "Bearish CHOCH"
  ) {
    shortScore += 14;
    shortReasons.push(
      "Bearish change of character"
    );
  }

  // 7. MSS — максимум 14 баллов
  if (data.mss === "Bullish MSS") {
    longScore += 14;
    longReasons.push(
      "Bullish market structure shift"
    );
  } else if (data.mss === "Bearish MSS") {
    shortScore += 14;
    shortReasons.push(
      "Bearish market structure shift"
    );
  }

  // 8. LIQUIDITY SWEEP — максимум 12 баллов
  if (
    data.liquiditySweep ===
    "Below Low Liquidity"
  ) {
    longScore += 12;
    longReasons.push(
      "Sell-side liquidity sweep"
    );
  } else if (
    data.liquiditySweep ===
    "Above High Liquidity"
  ) {
    shortScore += 12;
    shortReasons.push(
      "Buy-side liquidity sweep"
    );
  }

  // 9. FVG — учитываем только рядом с ценой
  const nearbyBullishFVG = fvg.find(
    item =>
      item?.type === "Bullish FVG" &&
      isPriceNearZone(item, 2)
  );

  const nearbyBearishFVG = fvg.find(
    item =>
      item?.type === "Bearish FVG" &&
      isPriceNearZone(item, 2)
  );

  if (nearbyBullishFVG) {
    longScore += 8;
    longReasons.push(
      `Bullish FVG near price: ${nearbyBullishFVG.from}-${nearbyBullishFVG.to}`
    );
  }

  if (nearbyBearishFVG) {
    shortScore += 8;
    shortReasons.push(
      `Bearish FVG near price: ${nearbyBearishFVG.from}-${nearbyBearishFVG.to}`
    );
  }

  // 10. ORDER BLOCK — только рядом с ценой
  const nearbyBullishOB = orderBlocks.find(
    item =>
      item?.type ===
        "Bullish Order Block" &&
      isPriceNearZone(item, 2.5)
  );

  const nearbyBearishOB = orderBlocks.find(
    item =>
      item?.type ===
        "Bearish Order Block" &&
      isPriceNearZone(item, 2.5)
  );

  if (nearbyBullishOB) {
    longScore += 10;
    longReasons.push(
      `Bullish order block near price: ${nearbyBullishOB.from}-${nearbyBullishOB.to}`
    );
  }

  if (nearbyBearishOB) {
    shortScore += 10;
    shortReasons.push(
      `Bearish order block near price: ${nearbyBearishOB.from}-${nearbyBearishOB.to}`
    );
  }

  // 11. EQUAL HIGHS / LOWS — только рядом с ценой
  const nearbyEqualHigh = equalHighs.find(
    level => isPriceNearLevel(level, 1.5)
  );

  const nearbyEqualLow = equalLows.find(
    level => isPriceNearLevel(level, 1.5)
  );

  if (nearbyEqualHigh !== undefined) {
    shortScore += 5;
    shortReasons.push(
      `Equal highs liquidity near ${nearbyEqualHigh}`
    );
  }

  if (nearbyEqualLow !== undefined) {
    longScore += 5;
    longReasons.push(
      `Equal lows liquidity near ${nearbyEqualLow}`
    );
  }

  // 12. IMBALANCE — максимум 6 баллов
  if (
    data.imbalance?.type ===
    "Bullish Imbalance"
  ) {
    longScore += 6;
    longReasons.push(
      "Bullish candle imbalance"
    );
  } else if (
    data.imbalance?.type ===
    "Bearish Imbalance"
  ) {
    shortScore += 6;
    shortReasons.push(
      "Bearish candle imbalance"
    );
  }
// 13. FUNDING RATE — максимум 6 баллов
if (fundingRate !== null) {
  if (fundingRate <= -0.01) {
    longScore += 6;
    longReasons.push(
      `Strong negative funding: ${fundingRate}`
    );
  } else if (fundingRate < -0.003) {
    longScore += 3;
    longReasons.push(
      `Negative funding: ${fundingRate}`
    );
  }

  if (fundingRate >= 0.01) {
    shortScore += 6;
    shortReasons.push(
      `Strong positive funding: ${fundingRate}`
    );
  } else if (fundingRate > 0.003) {
    shortScore += 3;
    shortReasons.push(
      `Positive funding: ${fundingRate}`
    );
  }
}

// 14. OPEN INTEREST + PRICE — максимум 8 баллов
const effectiveOiChange =
  openInterestChange4h ??
  openInterestChange1h ??
  openInterestChange24h;

if (
  effectiveOiChange !== null &&
  priceChange24h !== null
) {
  if (
    effectiveOiChange >= 1 &&
    priceChange24h > 0
  ) {
    longScore += 8;
    longReasons.push(
      `Price and OI rising: OI ${effectiveOiChange}%`
    );
  } else if (
    effectiveOiChange >= 1 &&
    priceChange24h < 0
  ) {
    shortScore += 8;
    shortReasons.push(
      `OI rising while price falls: OI ${effectiveOiChange}%`
    );
  } else if (
    effectiveOiChange <= -1 &&
    priceChange24h > 0
  ) {
    shortScore += 3;
    shortReasons.push(
      "Price rising while OI falls — possible short covering"
    );
  } else if (
    effectiveOiChange <= -1 &&
    priceChange24h < 0
  ) {
    longScore += 3;
    longReasons.push(
      "Price and OI falling — possible long liquidation exhaustion"
    );
  }
}

// 15. LONG / SHORT CROWDING — максимум 8 баллов
if (
  longAccount !== null &&
  shortAccount !== null
) {
  if (longAccount >= 75) {
    shortScore += 8;
    shortReasons.push(
      `Crowded longs: ${longAccount}%`
    );
  } else if (longAccount >= 68) {
    shortScore += 5;
    shortReasons.push(
      `Elevated long positioning: ${longAccount}%`
    );
  }

  if (shortAccount >= 75) {
    longScore += 8;
    longReasons.push(
      `Crowded shorts: ${shortAccount}%`
    );
  } else if (shortAccount >= 68) {
    longScore += 5;
    longReasons.push(
      `Elevated short positioning: ${shortAccount}%`
    );
  }
}

if (longShortRatio !== null) {
  if (longShortRatio >= 3) {
    shortScore += 3;
    shortReasons.push(
      `Extreme long/short ratio: ${longShortRatio}`
    );
  }

  if (longShortRatio <= 0.4) {
    longScore += 3;
    longReasons.push(
      `Extreme short/long ratio: ${longShortRatio}`
    );
  }
}

// 16. LIQUIDATIONS — максимум 8 баллов
if (
  longLiquidations !== null &&
  shortLiquidations !== null
) {
  const liquidationTotal =
    longLiquidations + shortLiquidations;

  if (liquidationTotal > 0) {
    const longShare =
      longLiquidations / liquidationTotal;

    const shortShare =
      shortLiquidations / liquidationTotal;

    if (longShare >= 0.7) {
      longScore += 8;
      longReasons.push(
        `Heavy long liquidations: ${Math.round(
          longShare * 100
        )}%`
      );
    } else if (longShare >= 0.6) {
      longScore += 4;
      longReasons.push(
        `Long liquidations dominate: ${Math.round(
          longShare * 100
        )}%`
      );
    }

    if (shortShare >= 0.7) {
      shortScore += 8;
      shortReasons.push(
        `Heavy short liquidations: ${Math.round(
          shortShare * 100
        )}%`
      );
    } else if (shortShare >= 0.6) {
      shortScore += 4;
      shortReasons.push(
        `Short liquidations dominate: ${Math.round(
          shortShare * 100
        )}%`
      );
    }
  }
}  
// 17. VOLUME CONFIRMATION — максимум 8 баллов
if (
  volumeSpike &&
  volumeRatio !== null &&
  priceChange24h !== null
) {
  if (
    priceChange24h > 0 &&
    macdValue > 0
  ) {
    longScore += 8;
    longReasons.push(
      `Bullish volume confirmation: ${volumeRatio}x average volume`
    );
  } else if (
    priceChange24h < 0 &&
    macdValue < 0
  ) {
    shortScore += 8;
    shortReasons.push(
      `Bearish volume confirmation: ${volumeRatio}x average volume`
    );
  } else {
    warnings.push(
      `Volume spike without directional confirmation: ${volumeRatio}x`
    );
  }
} else if (
  volumeRatio !== null &&
  volumeRatio < 0.7
) {
  warnings.push(
    `Low market volume: ${volumeRatio}x average`
  );
}   
  // Бонус за подтверждение несколькими факторами
  if (longReasons.length >= 5) {
    longScore += 5;
    longReasons.push(
      "Strong bullish confluence"
    );
  }

  if (shortReasons.length >= 5) {
    shortScore += 5;
    shortReasons.push(
      "Strong bearish confluence"
    );
  }

  longScore = Math.min(
    100,
    Math.round(longScore)
  );

  shortScore = Math.min(
    100,
    Math.round(shortScore)
  );

  const scoreDifference =
    Math.abs(longScore - shortScore);

  const score =
    Math.max(longScore, shortScore);
   
const totalDirectionalScore =
  longScore + shortScore;

let bullishProbability = 0;
let bearishProbability = 0;
let neutralProbability = 100;

if (totalDirectionalScore > 0) {
  bullishProbability = Math.round(
    longScore / totalDirectionalScore * 100
  );

  bearishProbability = Math.round(
    shortScore / totalDirectionalScore * 100
  );

  neutralProbability = Math.max(
    0,
    Math.round(
      100 -
      Math.min(
        100,
        scoreDifference * 3
      )
    )
  );

  const directionalShare =
    100 - neutralProbability;

  bullishProbability = Math.round(
    bullishProbability / 100 *
    directionalShare
  );

  bearishProbability =
    100 -
    neutralProbability -
    bullishProbability;
}   

  let signal = "Neutral";
  let direction = "Neutral";
  let reasons = [];

  if (
    longScore >= 75 &&
    longScore > shortScore &&
    scoreDifference >= 12
  ) {
    signal = "Strong Buy";
    direction = "Long";
    reasons = longReasons;
  } else if (
    longScore >= 55 &&
    longScore > shortScore &&
    scoreDifference >= 10
  ) {
    signal = "Buy";
    direction = "Long";
    reasons = longReasons;
  } else if (
    shortScore >= 75 &&
    shortScore > longScore &&
    scoreDifference >= 12
  ) {
    signal = "Strong Sell";
    direction = "Short";
    reasons = shortReasons;
  } else if (
    shortScore >= 55 &&
    shortScore > longScore &&
    scoreDifference >= 10
  ) {
    signal = "Sell";
    direction = "Short";
    reasons = shortReasons;
  } else {
    reasons = [
      ...longReasons.map(
        reason => `Bullish: ${reason}`
      ),
      ...shortReasons.map(
        reason => `Bearish: ${reason}`
      )
    ];

    if (scoreDifference < 10) {
      warnings.push(
        "Bullish and bearish signals conflict"
      );
    }

    if (score < 55) {
      warnings.push(
        "Not enough confirmation for a trade"
      );
    }
  }

  return {
    version: "3.0",
    score,
    signal,
    direction,
    
    probabilities: {
      bullish: bullishProbability,
      bearish: bearishProbability,
      neutral: neutralProbability
    },    
    
    longScore,
    shortScore,
    scoreDifference,

    confluence: {
      bullishFactors: longReasons.length,
      bearishFactors: shortReasons.length
    },
derivatives: {
  fundingRate,
  openInterestChange1h,
  openInterestChange4h,
  openInterestChange24h,
  longAccount,
  shortAccount,
  longShortRatio,
  longLiquidations,
  shortLiquidations
},  
volumeConfirmation: {
  current: volumeStats.current ?? null,
  average20: volumeStats.sma20 ?? null,
  ratio: volumeRatio,
  spike: volumeSpike
},    
    reasons,
    warnings
  };
}

function calculateSignalConfidence(data, probability) {
  if (!probability) {
    return {
      score: 0,
      grade: "D",
      quality: "No Data",
      agreement: "Unknown",
      penalties: []
    };
  }

  const longScore =
    Number(probability.longScore) || 0;

  const shortScore =
    Number(probability.shortScore) || 0;

  const leadingScore = Math.max(
    longScore,
    shortScore
  );

  const scoreDifference = Math.abs(
    longScore - shortScore
  );

  const bullishFactors =
    Number(
      probability.confluence?.bullishFactors
    ) || 0;

  const bearishFactors =
    Number(
      probability.confluence?.bearishFactors
    ) || 0;

  const totalFactors =
    bullishFactors + bearishFactors;

  const volumeRatio =
    Number(
      probability.volumeConfirmation?.ratio
    ) || 0;

  const volumeSpike =
    probability.volumeConfirmation?.spike === true;

  const warnings = Array.isArray(
    probability.warnings
  )
    ? probability.warnings
    : [];

  const penalties = [];

  /*
   * 1. Сила основного направления — 40%
   */
  const strengthScore =
    Math.min(100, leadingScore);

  /*
   * 2. Разница Long и Short — 25%
   */
  const separationScore =
    Math.min(
      100,
      scoreDifference * 5
    );

  /*
   * 3. Согласованность факторов — 20%
   */
  let confluenceScore = 0;

  if (totalFactors > 0) {
    const dominantFactors = Math.max(
      bullishFactors,
      bearishFactors
    );

    confluenceScore =
      dominantFactors / totalFactors * 100;
  }

  /*
   * 4. Подтверждение объёмом — 15%
   */
  let volumeScore = 40;

  if (volumeSpike) {
    volumeScore = 100;
  } else if (volumeRatio >= 1) {
    volumeScore = 70;
  } else if (volumeRatio >= 0.7) {
    volumeScore = 50;
  } else if (volumeRatio > 0) {
    volumeScore = 25;
    penalties.push(
      "Low volume reduces signal reliability"
    );
  }

  let confidence = Math.round(
    strengthScore * 0.4 +
    separationScore * 0.25 +
    confluenceScore * 0.2 +
    volumeScore * 0.15
  );

  /*
   * Штраф за нейтральный EMA-тренд
   */
  if (
    data.trend === "Neutral" ||
    warnings.some(item =>
      item.includes("EMA trend is neutral")
    )
  ) {
    confidence -= 8;

    penalties.push(
      "EMA trend is neutral or mixed"
    );
  }

  /*
   * Штраф за конфликт сигналов
   */
  if (scoreDifference < 10) {
    confidence -= 10;

    penalties.push(
      "Bullish and bearish signals are too close"
    );
  }

  /*
   * Штраф за малое количество подтверждений
   */
  if (totalFactors < 3) {
    confidence -= 8;

    penalties.push(
      "Not enough independent confirmations"
    );
  }

  /*
   * Бонус за направление тренда
   */
  const trendSupportsLong =
    data.trend === "Strong Bullish" &&
    longScore > shortScore;

  const trendSupportsShort =
    data.trend === "Strong Bearish" &&
    shortScore > longScore;

  if (
    trendSupportsLong ||
    trendSupportsShort
  ) {
    confidence += 10;
  }

  confidence = Math.max(
    0,
    Math.min(100, confidence)
  );

  let grade = "D";
  let quality = "Avoid";

  if (confidence >= 85) {
    grade = "A+";
    quality = "Excellent";
  } else if (confidence >= 75) {
    grade = "A";
    quality = "Very Good";
  } else if (confidence >= 65) {
    grade = "B";
    quality = "Good";
  } else if (confidence >= 55) {
    grade = "C";
    quality = "Average";
  }

  let agreement = "Mixed";

  if (scoreDifference >= 25) {
    agreement = "Strong";
  } else if (scoreDifference >= 12) {
    agreement = "Moderate";
  } else if (scoreDifference >= 8) {
    agreement = "Weak";
  }

  return {
    version: "1.0",
    score: confidence,
    grade,
    quality,
    agreement,

    components: {
      strength: Math.round(strengthScore),
      separation: Math.round(separationScore),
      confluence: Math.round(confluenceScore),
      volume: Math.round(volumeScore)
    },

    penalties
  };
}

function calculateAIAssessment(
  probability,
  confidence
) {
  if (!probability || !confidence) {
    return null;
  }

  const bullishProbability =
    Number(
      probability.probabilities?.bullish
    ) || 0;

  const bearishProbability =
    Number(
      probability.probabilities?.bearish
    ) || 0;

  const neutralProbability =
    Number(
      probability.probabilities?.neutral
    ) || 0;

  const confidenceScore =
    Number(confidence.score) || 0;

  const directionalProbability =
    Math.max(
      bullishProbability,
      bearishProbability
    );

  let direction = "Neutral";

  if (
    bullishProbability >
    bearishProbability
  ) {
    direction = "Long";
  }

  if (
    bearishProbability >
    bullishProbability
  ) {
    direction = "Short";
  }

  /*
   * Итоговая сила сетапа:
   * 60% — вероятность направления;
   * 40% — качество подтверждений.
   */
  const conviction = Math.round(
    directionalProbability * 0.6 +
    confidenceScore * 0.4
  );

  let grade = "D";
  let quality = "Avoid";

  if (
    conviction >= 85 &&
    neutralProbability <= 15
  ) {
    grade = "A+";
    quality = "Excellent";
  } else if (
    conviction >= 75 &&
    neutralProbability <= 25
  ) {
    grade = "A";
    quality = "Very Good";
  } else if (
    conviction >= 65 &&
    neutralProbability <= 35
  ) {
    grade = "B";
    quality = "Good";
  } else if (
    conviction >= 55 &&
    neutralProbability <= 45
  ) {
    grade = "C";
    quality = "Average";
  }

  const tradeAllowed =
    conviction >= 65 &&
    confidenceScore >= 60 &&
    neutralProbability <= 35;

  return {
    version: "3.1",

    direction,

    probabilities: {
      bullish: bullishProbability,
      bearish: bearishProbability,
      neutral: neutralProbability
    },

    directionalProbability,
    confidence: confidenceScore,
    conviction,

    grade,
    quality,
    tradeAllowed
  };
}
function calculateMarketEnvironment(data) {
  const reasons = [];
  const warnings = [];

  const price =
    typeof data?.price === "number" &&
    Number.isFinite(data.price) &&
    data.price > 0
      ? data.price
      : null;

  const atr14 =
    typeof data?.atr14 === "number" &&
    Number.isFinite(data.atr14) &&
    data.atr14 >= 0
      ? data.atr14
      : null;

  const volumeRatio =
    typeof data?.volumeStats?.ratio === "number" &&
    Number.isFinite(data.volumeStats.ratio)
      ? data.volumeStats.ratio
      : null;

  const volumeSpike =
    data?.volumeStats?.spike === true;

  const neutralProbability =
    typeof data?.probability?.probabilities?.neutral === "number"
      ? data.probability.probabilities.neutral
      : null;

  const confidence =
    typeof data?.probability?.confidence?.score === "number"
      ? data.probability.confidence.score
      : null;

  const coinGlassAvailable =
    data?.coinGlass?.available === true;

  /*
   * Волатильность нормализуется относительно цены.
   * Это позволяет сравнивать разные монеты.
   */
  const atrPercent =
    price !== null && atr14 !== null
      ? atr14 / price * 100
      : null;

  /*
   * 1. PARTICIPATION — 30 баллов
   * Оценивает активность рынка через объём.
   */
  let participationScore = 0;
  let participation = "Unknown";

  if (volumeRatio !== null) {
    if (volumeRatio >= 1.5) {
      participationScore = 30;
      participation = "Very High";
      reasons.push(
        `Very high market participation: ${volumeRatio}x average volume`
      );
    } else if (volumeRatio >= 1) {
      participationScore = 25;
      participation = "High";
      reasons.push(
        `Healthy market participation: ${volumeRatio}x average volume`
      );
    } else if (volumeRatio >= 0.7) {
      participationScore = 18;
      participation = "Moderate";
    } else if (volumeRatio >= 0.4) {
      participationScore = 10;
      participation = "Low";
      warnings.push(
        `Low market participation: ${volumeRatio}x average volume`
      );
    } else {
      participationScore = 4;
      participation = "Very Low";
      warnings.push(
        `Very low market participation: ${volumeRatio}x average volume`
      );
    }
  } else {
    warnings.push(
      "Volume participation data is unavailable"
    );
  }

  /*
   * 2. VOLATILITY — 25 баллов
   * Лучшее состояние — достаточное движение
   * без экстремальной нестабильности.
   */
  let volatilityScore = 0;
  let volatility = "Unknown";

  if (atrPercent !== null) {
    if (atrPercent < 1) {
      volatilityScore = 8;
      volatility = "Very Low";
      warnings.push(
        `Volatility is too low: ATR ${atrPercent.toFixed(2)}%`
      );
    } else if (atrPercent < 2) {
      volatilityScore = 18;
      volatility = "Low";
    } else if (atrPercent <= 5) {
      volatilityScore = 25;
      volatility = "Normal";
      reasons.push(
        `Tradable volatility: ATR ${atrPercent.toFixed(2)}%`
      );
    } else if (atrPercent <= 8) {
      volatilityScore = 17;
      volatility = "High";
      warnings.push(
        `Elevated volatility: ATR ${atrPercent.toFixed(2)}%`
      );
    } else {
      volatilityScore = 6;
      volatility = "Extreme";
      warnings.push(
        `Extreme volatility: ATR ${atrPercent.toFixed(2)}%`
      );
    }
  } else {
    warnings.push(
      "Normalized volatility data is unavailable"
    );
  }

  /*
   * 3. MARKET CLARITY — 30 баллов
   * Низкая neutral probability и высокая confidence
   * означают более понятную рыночную среду.
   */
  let clarityScore = 0;
  let clarity = "Unknown";

  if (
    neutralProbability !== null &&
    confidence !== null
  ) {
    const directionalClarity =
      Math.max(0, 100 - neutralProbability);

    clarityScore = Math.round(
      directionalClarity * 0.18 +
      confidence * 0.12
    );

    clarityScore = Math.max(
      0,
      Math.min(30, clarityScore)
    );

    if (clarityScore >= 24) {
      clarity = "Clear";
      reasons.push(
        "Market signals show strong directional clarity"
      );
    } else if (clarityScore >= 17) {
      clarity = "Moderate";
    } else if (clarityScore >= 10) {
      clarity = "Mixed";
      warnings.push(
        "Market direction remains uncertain"
      );
    } else {
      clarity = "Unclear";
      warnings.push(
        "Market uncertainty is too high"
      );
    }
  } else {
    warnings.push(
      "Probability or confidence data is unavailable"
    );
  }

  /*
   * 4. DATA QUALITY — 15 баллов
   */
  let dataQualityScore = 0;
  let dataQuality = "Limited";

  const coreDataAvailable =
    price !== null &&
    atr14 !== null &&
    volumeRatio !== null &&
    neutralProbability !== null &&
    confidence !== null;

  if (coreDataAvailable && coinGlassAvailable) {
    dataQualityScore = 15;
    dataQuality = "Complete";
  } else if (coreDataAvailable) {
    dataQualityScore = 10;
    dataQuality = "Core Data Available";
    warnings.push(
      "CoinGlass derivatives data is incomplete"
    );
  } else {
    dataQualityScore = 4;
    dataQuality = "Incomplete";
    warnings.push(
      "Core market environment data is incomplete"
    );
  }

  let score =
    participationScore +
    volatilityScore +
    clarityScore +
    dataQualityScore;

  /*
   * Дополнительный штраф:
   * всплеск объёма при экстремальной волатильности
   * может означать ликвидационное событие.
   */
  if (
    volumeSpike &&
    atrPercent !== null &&
    atrPercent > 8
  ) {
    score -= 10;

    warnings.push(
      "Volume spike combined with extreme volatility"
    );
  }

  score = Math.max(
    0,
    Math.min(100, Math.round(score))
  );

  let condition = "Dangerous";

  if (score >= 80) {
    condition = "Excellent";
  } else if (score >= 65) {
    condition = "Healthy";
  } else if (score >= 50) {
    condition = "Caution";
  } else if (score >= 35) {
    condition = "Poor";
  }

  /*
   * tradable — оценка среды, а не разрешение сделки.
   * Конкретный вход всё равно определяет Decision Engine.
   */
  const tradable =
    score >= 60 &&
    volatility !== "Extreme" &&
    participation !== "Very Low" &&
    dataQuality !== "Incomplete";

  return {
    version: "1.0",

    score,
    condition,
    tradable,

    components: {
      participation: {
        score: participationScore,
        maxScore: 30,
        status: participation,
        volumeRatio,
        volumeSpike
      },

      volatility: {
        score: volatilityScore,
        maxScore: 25,
        status: volatility,
        atrPercent:
          atrPercent !== null
            ? Number(atrPercent.toFixed(2))
            : null
      },

      clarity: {
        score: clarityScore,
        maxScore: 30,
        status: clarity,
        neutralProbability,
        confidence
      },

      dataQuality: {
        score: dataQualityScore,
        maxScore: 15,
        status: dataQuality,
        coinGlassAvailable
      }
    },

    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)]
  };
}

function calculateTradeReadiness(data) {
  const environment =
    data?.marketEnvironment || {};

  const probability =
    data?.probability || {};

  const confidence =
    probability?.confidence || {};

  const marketBias =
    data?.marketBias || {};

  const reasons = [];
  const blockers = [];

  const environmentScore =
    typeof environment.score === "number"
      ? environment.score
      : 0;

  const environmentTradable =
    environment.tradable === true;

  const confidenceScore =
    typeof confidence.score === "number"
      ? confidence.score
      : 0;

  const neutralProbability =
    typeof probability.probabilities?.neutral === "number"
      ? probability.probabilities.neutral
      : 100;

  const scoreDifference =
    typeof probability.scoreDifference === "number"
      ? probability.scoreDifference
      : 0;

  const bias =
    marketBias.bias || "Neutral";

  /*
   * 1. Качество рыночной среды — 40%
   */
  const environmentComponent =
    Math.min(40, Math.round(
      environmentScore * 0.4
    ));

  if (environmentTradable) {
    reasons.push(
      "Market environment is tradable"
    );
  } else {
    blockers.push(
      "Market environment is not tradable"
    );
  }

  /*
   * 2. Уверенность сигнала — 30%
   */
  const confidenceComponent =
    Math.min(30, Math.round(
      confidenceScore * 0.3
    ));

  if (confidenceScore >= 60) {
    reasons.push(
      "Signal confidence is acceptable"
    );
  } else {
    blockers.push(
      `Signal confidence is too low: ${confidenceScore}`
    );
  }

  /*
   * 3. Ясность направления — 20%
   */
  const directionalClarity =
    Math.max(
      0,
      100 - neutralProbability
    );

  const clarityComponent =
    Math.min(20, Math.round(
      directionalClarity * 0.2
    ));

  if (
    bias !== "Neutral" &&
    neutralProbability <= 40
  ) {
    reasons.push(
      `${bias} directional bias is confirmed`
    );
  } else {
    blockers.push(
      "Directional bias is not sufficiently clear"
    );
  }

  /*
   * 4. Разделение Long / Short — 10%
   */
  const separationComponent =
    Math.min(
      10,
      Math.round(scoreDifference / 2)
    );

  if (scoreDifference >= 12) {
    reasons.push(
      "Bullish and bearish scores are sufficiently separated"
    );
  } else {
    blockers.push(
      `Long and Short scores are too close: ${scoreDifference}`
    );
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      environmentComponent +
      confidenceComponent +
      clarityComponent +
      separationComponent
    )
  );

  /*
   * Ready означает:
   * среда разрешает торговлю,
   * есть направление,
   * confidence достаточный,
   * конфликт между Long и Short отсутствует.
   */
  const ready =
    environmentTradable &&
    environmentScore >= 60 &&
    confidenceScore >= 60 &&
    bias !== "Neutral" &&
    neutralProbability <= 40 &&
    scoreDifference >= 12;

  let status = "Blocked";

  if (ready && score >= 80) {
    status = "Ready";
  } else if (ready) {
    status = "Conditional";
  } else if (
    environmentTradable &&
    score >= 50
  ) {
    status = "Waiting Confirmation";
  }

  return {
    version: "1.0",

    score,
    ready,
    status,

    direction:
      bias === "Bullish"
        ? "Long"
        : bias === "Bearish"
          ? "Short"
          : "Neutral",

    components: {
      environment: {
        score: environmentComponent,
        maxScore: 40,
        sourceScore: environmentScore
      },

      confidence: {
        score: confidenceComponent,
        maxScore: 30,
        sourceScore: confidenceScore
      },

      clarity: {
        score: clarityComponent,
        maxScore: 20,
        neutralProbability
      },

      separation: {
        score: separationComponent,
        maxScore: 10,
        scoreDifference
      }
    },

    reasons: [...new Set(reasons)],
    blockers: [...new Set(blockers)]
  };
}

function calculateMarketSummary(data) {
  const probability = data?.probability || {};
  const confidence = probability?.confidence || {};
  const aiAssessment =
    probability?.aiAssessment || {};

  const tradePlan = data?.tradePlan || {};
  const decisionEngine =
    data?.decisionEngine || {};
  const recommendation =
    data?.recommendation || {};

  const probabilities =
    probability?.probabilities || {};

  const action =
    decisionEngine?.summary?.action ||
    "WAIT";

  const marketBias =
    decisionEngine?.summary?.marketBias ||
    "Neutral";

  const confidenceScore =
    typeof confidence.score === "number"
      ? confidence.score
      : 0;

  const conviction =
    typeof aiAssessment.conviction === "number"
      ? aiAssessment.conviction
      : 0;

  const grade =
    recommendation.grade ||
    aiAssessment.grade ||
    "D";

  const setupQuality =
    recommendation.setupQuality || {
      stars: 1,
      label: "Avoid"
    };

  const entryTiming =
    recommendation.entryTiming || {
      status: "Wait Confirmation",
      priority: "Low",
      instruction:
        "Wait for a confirmed setup"
    };

  const riskReward =
    typeof tradePlan.riskReward === "number"
      ? tradePlan.riskReward
      : null;

  return {
    version: "1.0",

    action,
    marketBias,

    tradeAllowed:
      tradePlan.validTrade === true,

    grade,

    setupQuality: {
      stars:
        Number(setupQuality.stars) || 1,
      label:
        setupQuality.label || "Avoid"
    },

    probability: {
      bullish:
        Number(probabilities.bullish) || 0,
      bearish:
        Number(probabilities.bearish) || 0,
      neutral:
        Number(probabilities.neutral) || 0
    },

    confidence: confidenceScore,
    conviction,

    risk:
      recommendation.risk || "High",

    entryStatus: {
      status: entryTiming.status,
      priority: entryTiming.priority,
      instruction: entryTiming.instruction
    },

    execution: {
      direction:
        tradePlan.direction || "Wait",

      entryZone:
        tradePlan.entryZone ?? null,

      stopLoss:
        tradePlan.stopLoss ?? null,

      takeProfit1:
        tradePlan.takeProfit1 ?? null,

      takeProfit2:
        tradePlan.takeProfit2 ?? null,

      takeProfit3:
        tradePlan.takeProfit3 ?? null,

      recommendedTakeProfit:
        tradePlan.recommendedTakeProfit ??
        null,

      riskReward
    }
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

  let longScore = probability.longScore ?? 0;
let shortScore = probability.shortScore ?? 0;

const probabilityReasons =
  Array.isArray(probability.reasons)
    ? probability.reasons
    : [];

const longReasons = probabilityReasons
  .filter(r => r.startsWith("Bullish:"))
  .map(r => r.replace("Bullish: ", ""));

const shortReasons = probabilityReasons
  .filter(r => r.startsWith("Bearish:"))
  .map(r => r.replace("Bearish: ", ""));
  
  
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
  smartMoney.rating === "Bearish" &&
  typeof smartMoney.score === "number" &&
  smartMoney.score <= 25
) {
  shortScore += 8;
  shortReasons.push("Bearish Smart Money score");
}  
if (
  smartMoney.rating === "Bullish" &&
  typeof smartMoney.score === "number" &&
  smartMoney.score >= 75
) {
  longScore += 8;
  longReasons.push("Bullish Smart Money score");
} 
  
  longScore = Math.min(100, longScore);
  shortScore = Math.min(100, shortScore);
  
  const minimumSetupScore = 55;
  const minimumScoreDifference = 12;

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
function calculateMarketBias(probability) {
  if (!probability) {
    return {
      bias: "Neutral",
      strength: 0,
      dominantProbability: 0,
      neutralProbability: 100,
      difference: 0,
      reason: "Probability data is unavailable"
    };
  }

  const bullish =
    typeof probability.probabilities?.bullish === "number"
      ? probability.probabilities.bullish
      : 0;

  const bearish =
    typeof probability.probabilities?.bearish === "number"
      ? probability.probabilities.bearish
      : 0;

  const neutral =
    typeof probability.probabilities?.neutral === "number"
      ? probability.probabilities.neutral
      : 100;

  const difference = Math.abs(
    bullish - bearish
  );

  const dominantProbability = Math.max(
    bullish,
    bearish
  );

  /*
   * Neutral остаётся главным сценарием,
   * если его вероятность выше направления.
   */
  if (
    neutral >= dominantProbability ||
    neutral >= 50
  ) {
    return {
      bias: "Neutral",
      strength: neutral,
      dominantProbability,
      neutralProbability: neutral,
      difference,
      reason:
        "Neutral probability dominates directional scenarios"
    };
  }

  /*
   * Направление не подтверждается,
   * если разница между Bullish и Bearish слишком мала.
   */
  if (difference < 10) {
    return {
      bias: "Neutral",
      strength: dominantProbability,
      dominantProbability,
      neutralProbability: neutral,
      difference,
      reason:
        "Bullish and bearish probabilities are too close"
    };
  }

  if (bullish > bearish) {
    return {
      bias: "Bullish",
      strength: bullish,
      dominantProbability: bullish,
      neutralProbability: neutral,
      difference,
      reason:
        "Bullish probability is dominant"
    };
  }

  return {
    bias: "Bearish",
    strength: bearish,
    dominantProbability: bearish,
    neutralProbability: neutral,
    difference,
    reason:
      "Bearish probability is dominant"
  };
}

function calculateDecisionEngine(data) {
  const probability = data?.probability || {};
  const confidence = probability?.confidence || {};
  const tradePlan = data?.tradePlan || {};
  const smartMoney = data?.smartMoney || {};
  const levels = data?.levels || {};
  const volumeStats = data?.volumeStats || {};

  const marketBiasResult =
  data?.marketBias || {
    bias: "Neutral",
    strength: 0,
    dominantProbability: 0,
    neutralProbability: 100,
    difference: 0,
    reason: "Market bias data is unavailable"
  };

const marketBias =
  marketBiasResult.bias || "Neutral";
  
  const longScore =
    typeof probability.longScore === "number"
      ? probability.longScore
      : 0;

  const shortScore =
    typeof probability.shortScore === "number"
      ? probability.shortScore
      : 0;

  const signalStrength = Math.max(longScore, shortScore);

  const confidenceScore =
    typeof confidence.score === "number"
      ? confidence.score
      : 0;

  const bullishFactors = [];
  const bearishFactors = [];
  const riskFactors = [];

  const probabilityReasons =
    Array.isArray(probability.reasons)
      ? probability.reasons
      : [];

  for (const reason of probabilityReasons) {
    if (typeof reason !== "string") continue;

    if (reason.startsWith("Bullish:")) {
      bullishFactors.push(
        reason.replace(/^Bullish:\s*/, "")
      );
    }

    if (reason.startsWith("Bearish:")) {
      bearishFactors.push(
        reason.replace(/^Bearish:\s*/, "")
      );
    }
  }

  const warnings =
    Array.isArray(probability.warnings)
      ? probability.warnings
      : [];

  riskFactors.push(...warnings);

  const confidencePenalties =
    Array.isArray(confidence.penalties)
      ? confidence.penalties
      : [];

  for (const penalty of confidencePenalties) {
    if (!riskFactors.includes(penalty)) {
      riskFactors.push(penalty);
    }
  }

  if (smartMoney.rating === "Bullish") {
    bullishFactors.push("Smart Money bias is bullish");
  }

  if (smartMoney.rating === "Bearish") {
    bearishFactors.push("Smart Money bias is bearish");
  }

  if (
    typeof volumeStats.ratio === "number" &&
    volumeStats.ratio < 0.7
  ) {
    const warning =
      `Low volume: ${volumeStats.ratio}x average`;

    if (!riskFactors.includes(warning)) {
      riskFactors.push(warning);
    }
  }

  let action = "WAIT";

  if (
    tradePlan.validTrade === true &&
    tradePlan.direction === "Long"
  ) {
    action = "BUY";
  }

  if (
    tradePlan.validTrade === true &&
    tradePlan.direction === "Short"
  ) {
    action = "SELL";
  }

  let tradeQuality =
    confidence.grade || "D";

  if (!tradePlan.validTrade) {
    tradeQuality = "D";
  }

  let nextTrigger =
    "Wait for stronger confirmation and sufficient volume.";

  if (action === "BUY") {
    nextTrigger =
      `Enter Long only inside ${tradePlan.entryZone?.from ?? "N/A"}–${tradePlan.entryZone?.to ?? "N/A"}, with Stop Loss at ${tradePlan.stopLoss ?? "N/A"}.`;
  } else if (action === "SELL") {
    nextTrigger =
      `Enter Short only inside ${tradePlan.entryZone?.from ?? "N/A"}–${tradePlan.entryZone?.to ?? "N/A"}, with Stop Loss at ${tradePlan.stopLoss ?? "N/A"}.`;
  } else if (marketBias === "Bearish") {
    if (typeof levels.support === "number") {
      nextTrigger =
        `Wait for bearish structure confirmation and a breakdown below support ${levels.support}. Do not enter without increasing volume.`;
    } else {
      nextTrigger =
        "Wait for bearish CHOCH or BOS with increasing volume before considering a Short.";
    }
  } else if (marketBias === "Bullish") {
    if (typeof levels.resistance === "number") {
      nextTrigger =
        `Wait for bullish structure confirmation and a breakout above resistance ${levels.resistance}. Do not enter without increasing volume.`;
    } else {
      nextTrigger =
        "Wait for bullish CHOCH or BOS with increasing volume before considering a Long.";
    }
  }

  let invalidation = null;

  if (
    marketBias === "Bearish" &&
    typeof levels.resistance === "number"
  ) {
    invalidation =
      `Bearish scenario weakens above ${levels.resistance}.`;
  }

  if (
    marketBias === "Bullish" &&
    typeof levels.support === "number"
  ) {
    invalidation =
      `Bullish scenario weakens below ${levels.support}.`;
  }

  const summaryText =
    action === "WAIT"
      ? `${marketBias} market bias, but no confirmed trade. Signal strength ${signalStrength}/100 and confidence ${confidenceScore}/100.`
      : `${action} setup confirmed. Signal strength ${signalStrength}/100 and confidence ${confidenceScore}/100.`;

  return {
    version: "3.0",

summary: {
  marketBias,
  marketBiasDetails: marketBiasResult,
  action,
  signalStrength,
  confidence: confidenceScore,
  tradeQuality,
  validTrade: tradePlan.validTrade === true,
  text: summaryText
},
    
    bullishFactors: [...new Set(bullishFactors)],
    bearishFactors: [...new Set(bearishFactors)],
    riskFactors: [...new Set(riskFactors)],

    execution: {
      entryZone: tradePlan.entryZone ?? null,
      stopLoss: tradePlan.stopLoss ?? null,
      takeProfit1: tradePlan.takeProfit1 ?? null,
      takeProfit2: tradePlan.takeProfit2 ?? null,
      takeProfit3: tradePlan.takeProfit3 ?? null,
      recommendedTakeProfit:
        tradePlan.recommendedTakeProfit ?? null,
      riskReward: tradePlan.riskReward ?? null
    },

    nextTrigger,
    invalidation
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

     direction:
        tradePlan.direction === "Wait"
            ? "Neutral"
            : tradePlan.direction,
      
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
async function fetchOKXKlines(
  symbol,
  interval = "1D",
  limit = 1200
) {
  const instId = symbol.replace(
    /^(.*?)(USDT)$/i,
    "$1-USDT"
  );

  const pageLimit = 100;
  const candlesByTime = new Map();

  let after = null;
  let lastOldestTimestamp = null;

  try {
    while (candlesByTime.size < limit) {
      const remaining = limit - candlesByTime.size;
      const currentLimit = Math.min(pageLimit, remaining);

      const url = new URL(
        "https://www.okx.com/api/v5/market/history-candles"
      );

      url.searchParams.set("instId", instId);
      url.searchParams.set("bar", interval);
      url.searchParams.set("limit", String(currentLimit));

      if (after !== null) {
        url.searchParams.set("after", String(after));
      }

      const response = await fetch(url);

      const payload = await response
        .json()
        .catch(() => null);

      if (
        !response.ok ||
        payload?.code !== "0" ||
        !Array.isArray(payload?.data)
      ) {
        return {
          ok: false,
          status: response.status,
          source: "OKX",
          interval,
          error:
            payload?.msg ||
            `OKX history candles failed: ${response.status}`,
          data: []
        };
      }

      if (payload.data.length === 0) {
        break;
      }

      let oldestTimestamp = null;

      for (const item of payload.data) {
        const candle = {
          openTime: Number(item[0]),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5]),
          quoteVolume: Number(item[7]),
          confirmed: item[8] === "1"
        };

        const valid =
          Number.isFinite(candle.openTime) &&
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close) &&
          Number.isFinite(candle.volume);

        if (!valid) continue;

        candlesByTime.set(candle.openTime, candle);

        if (
          oldestTimestamp === null ||
          candle.openTime < oldestTimestamp
        ) {
          oldestTimestamp = candle.openTime;
        }
      }

      if (
        oldestTimestamp === null ||
        oldestTimestamp === lastOldestTimestamp
      ) {
        break;
      }

      lastOldestTimestamp = oldestTimestamp;
      after = oldestTimestamp;

      if (payload.data.length < currentLimit) {
        break;
      }
    }

    const candles = Array
      .from(candlesByTime.values())
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-limit);

    return {
      ok: candles.length > 0,
      status: 200,
      source: "OKX",
      interval,
      count: candles.length,
      data: candles,
      error:
        candles.length > 0
          ? null
          : "No OKX historical candles returned"
    };
  } catch (error) {
    return {
      ok: false,
      source: "OKX",
      interval,
      error: error.message,
      data: []
    };
  }
}
function calculateDerivativesHistory(coinGlass) {
  const source = coinGlass || {};

  const fundingRate =
    source.fundingRate || null;

  const openInterest =
    source.openInterest || null;

  const longShortRatio =
    source.longShortRatio || null;

  const liquidations =
    Array.isArray(source.liquidations)
      ? source.liquidations
      : [];

  const aggregatedLiquidations =
    liquidations.find(
      item => item?.exchange === "All"
    ) || null;

  return {
    version: "1.0",

    available:
      source.available === true,

    funding: {
      current: fundingRate
        ? {
            exchange:
              fundingRate.exchange ?? null,

            rate:
              typeof fundingRate.rate === "number"
                ? fundingRate.rate
                : null,

            intervalHours:
              fundingRate.intervalHours ?? null,

            nextFundingTime:
              fundingRate.nextFundingTime ?? null
          }
        : null,

      history: [],

      historyAvailable: false
    },

    openInterest: {
      current: openInterest
        ? {
            exchange:
              openInterest.exchange ?? null,

            usd:
              typeof openInterest.usd === "number"
                ? openInterest.usd
                : null,

            quantity:
              typeof openInterest.quantity === "number"
                ? openInterest.quantity
                : null,

            changes: {
              change5m:
                typeof openInterest.change5m === "number"
                  ? openInterest.change5m
                  : null,

              change15m:
                typeof openInterest.change15m === "number"
                  ? openInterest.change15m
                  : null,

              change30m:
                typeof openInterest.change30m === "number"
                  ? openInterest.change30m
                  : null,

              change1h:
                typeof openInterest.change1h === "number"
                  ? openInterest.change1h
                  : null,

              change4h:
                typeof openInterest.change4h === "number"
                  ? openInterest.change4h
                  : null,

              change24h:
                typeof openInterest.change24h === "number"
                  ? openInterest.change24h
                  : null
            }
          }
        : null,

      history: [],

      historyAvailable: false
    },

    longShort: {
      current: longShortRatio
        ? {
            exchange:
              longShortRatio.exchange ?? null,

            longAccount:
              typeof longShortRatio.longAccount === "number"
                ? longShortRatio.longAccount
                : null,

            shortAccount:
              typeof longShortRatio.shortAccount === "number"
                ? longShortRatio.shortAccount
                : null,

            ratio:
              typeof longShortRatio.ratio === "number"
                ? longShortRatio.ratio
                : null,

            timestamp:
              longShortRatio.timestamp ?? null
          }
        : null,

      history: [],

      historyAvailable: false
    },

    liquidations: {
      current: aggregatedLiquidations
        ? {
            exchange:
              aggregatedLiquidations.exchange ?? "All",

            totalUsd:
              typeof aggregatedLiquidations.liquidation_usd === "number"
                ? aggregatedLiquidations.liquidation_usd
                : null,

            longUsd:
              typeof aggregatedLiquidations.longLiquidation_usd === "number"
                ? aggregatedLiquidations.longLiquidation_usd
                : null,

            shortUsd:
              typeof aggregatedLiquidations.shortLiquidation_usd === "number"
                ? aggregatedLiquidations.shortLiquidation_usd
                : null
          }
        : null,

      exchanges: liquidations,

      history: [],

      historyAvailable: false
    },

    errors: source.errors || {}
  };
}

async function fetchCoinGlass(path, params = {}) {
  const apiKey = process.env.COINGLASS_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: "COINGLASS_API_KEY is not configured"
    };
  }

  const url = new URL(
    `https://open-api-v4.coinglass.com${path}`
  );

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "CG-API-KEY": apiKey
      }
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || payload?.code !== "0") {
      return {
        ok: false,
        status: response.status,
        error: payload?.msg || "CoinGlass request failed",
        raw: payload
      };
    }

    return {
      ok: true,
      status: response.status,
      data: payload.data
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

async function getCoinGlassMarketData(symbol) {
  const asset = symbol.replace(/USDT$/i, "");
const [
  fundingResponse,
  openInterestResponse,
  longShortResponse,
  liquidationResponse,
  
] = await Promise.all([
  
  fetchCoinGlass(
    "/api/futures/funding-rate/exchange-list"
  ),

  fetchCoinGlass(
    "/api/futures/open-interest/exchange-list",
    {
      symbol: asset
    }
  ),

  fetchCoinGlass(
    "/api/futures/global-long-short-account-ratio/history",
    {
      exchange: "Binance",
      symbol,
      interval: "4h",
      limit: 1
    }
  ),

  fetchCoinGlass(
  "/api/futures/liquidation/exchange-list",
  {
    symbol: asset,
    range: "24h"
  }
),
]);
  
  let fundingRate = null;

  if (
    fundingResponse.ok &&
    Array.isArray(fundingResponse.data)
  ) {
    const coinData = fundingResponse.data.find(
      item => item?.symbol === asset
    );

    const stablecoinList = Array.isArray(
      coinData?.stablecoin_margin_list
    )
      ? coinData.stablecoin_margin_list
      : [];

    const binanceFunding = stablecoinList.find(
      item => item?.exchange === "Binance"
    );

    if (binanceFunding) {
      fundingRate = {
        exchange: "Binance",
        rate:
          typeof binanceFunding.funding_rate === "number"
            ? binanceFunding.funding_rate
            : null,
        intervalHours:
          binanceFunding.funding_rate_interval ?? null,
        nextFundingTime:
          binanceFunding.next_funding_time ?? null
      };
    }
  }

  let openInterest = null;

  if (
    openInterestResponse.ok &&
    Array.isArray(openInterestResponse.data)
  ) {
    const aggregated =
      openInterestResponse.data.find(
        item => item?.exchange === "All"
      ) || openInterestResponse.data[0];

    if (aggregated) {
      openInterest = {
        exchange: aggregated.exchange ?? "All",
        usd: aggregated.open_interest_usd ?? null,
        quantity: aggregated.open_interest_quantity ?? null,
        change5m:
          aggregated.open_interest_change_percent_5m ?? null,
        change15m:
          aggregated.open_interest_change_percent_15m ?? null,
        change30m:
          aggregated.open_interest_change_percent_30m ?? null,
        change1h:
          aggregated.open_interest_change_percent_1h ?? null,
        change4h:
          aggregated.open_interest_change_percent_4h ?? null,
        change24h:
          aggregated.open_interest_change_percent_24h ?? null
      };
    }
  }
let longShortRatio = null;

if (
  longShortResponse.ok &&
  Array.isArray(longShortResponse.data) &&
  longShortResponse.data.length > 0
) {
  const last =
    longShortResponse.data[
      longShortResponse.data.length - 1
    ];
longShortRatio = {
  exchange: "Binance",

  longAccount:
    last.global_account_long_percent ?? null,

  shortAccount:
    last.global_account_short_percent ?? null,

  ratio:
    last.global_account_long_short_ratio ?? null,

  timestamp:
    last.time ?? null
};
}  
let liquidations = null;

if (
  liquidationResponse.ok &&
  Array.isArray(liquidationResponse.data)
) {
  liquidations = liquidationResponse.data;
}
  
return {
available:
  fundingResponse.ok ||
  openInterestResponse.ok ||
  longShortResponse.ok ||
  liquidationResponse.ok,  
  
 fundingRate,
 openInterest,
 longShortRatio,
 liquidations,
  
  errors: {
  fundingRate: fundingResponse.ok
    ? null
    : fundingResponse.error,

  openInterest: openInterestResponse.ok
    ? null
    : openInterestResponse.error,

  longShortRatio: longShortResponse.ok
    ? null
    : longShortResponse.error,

  liquidations: liquidationResponse.ok
    ? null
    : liquidationResponse.error
}
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

    const coinGlass = 
      await getCoinGlassMarketData(symbol);
const okxDailyResponse =
  await fetchOKXKlines(
    symbol,
    "1D"
  );   

const okxDailyCandles =
  okxDailyResponse.ok
    ? okxDailyResponse.data
    : [];

const okxDailyCloses =
  okxDailyCandles.map(
    candle => candle.close
  );
   
const okxDailyVolumes =
  okxDailyCandles.map(
    candle => candle.volume
  );

const okxDailyOhlc =
  okxDailyCandles.map(candle => [
    candle.openTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close
  ]);

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

   const rsi14 = calculateRSI(okxDailyCloses, 14);
   const ema20 = calculateEMA(okxDailyCloses, 20);
   const ema50 = calculateEMA(okxDailyCloses, 50);
   const ema100 = calculateEMA(okxDailyCloses, 100);
 
   const ema200 = calculateEMA(okxDailyCloses, 200);

   const macd = calculateMACD(okxDailyCloses);
   const levels = calculateLevels(okxDailyCloses);

   const atr14 = calculateATR(okxDailyOhlc, 14);
   const volumeStats =
     calculateVolumeStats(okxDailyVolumes);

   const swingLevels =
     calculateSwingLevels(okxDailyCloses);   
    const bos = calculateBOS(coin.current_price, swingLevels);
    const choch = calculateCHOCH(bos, ema20, ema50);
    const liquiditySweep = calculateLiquiditySweep(
    coin.current_price,
    swingLevels
);
     const fvg = calculateFVG(okxDailyOhlc);
     const orderBlocks =
       calculateOrderBlocks(okxDailyOhlc);   
     const premiumDiscount = calculatePremiumDiscount(
      coin.current_price,
      swingLevels
    );    
const equalHighLow =
  calculateEqualHighLow(okxDailyOhlc);

const imbalance =
  calculateImbalance(okxDailyOhlc);   
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
const probabilityBase =
  calculateProbabilityScore({
    price: coin.current_price,
    change24h:
      coin.price_change_percentage_24h,
    volumeStats,

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
    equalHighLow,
    coinGlass
  });
const probabilityConfidence =
  calculateSignalConfidence(
    {
      trend,
      volumeStats
    },
    probabilityBase
  );

const probability = {
  ...probabilityBase,

  version: "3.1",

  confidence: probabilityConfidence,

  aiAssessment:
    calculateAIAssessment(
      probabilityBase,
      probabilityConfidence
    )
}; 
   const marketBias =
  calculateMarketBias(probability);
   
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
   
const decisionEngine = calculateDecisionEngine({
  probability,
  tradePlan,
  smartMoney,
  marketBias,  
  levels,
  volumeStats,
  trend,
  bos,
  choch,
  mss
});

   const marketEnvironment =
  calculateMarketEnvironment({
    price: coin.current_price,
    atr14,
    volumeStats,
    probability,
    coinGlass
  });
   
const tradeReadiness =
  calculateTradeReadiness({
    marketEnvironment,
    probability,
    marketBias
  });
   
 const recommendation = calculateRecommendation({
  probability,
  smartMoney,
  tradePlan,
  trend,
  macd,
  premiumDiscount
});

   const derivativesHistory =
  calculateDerivativesHistory(
    coinGlass
  );
   
const marketSummary =
  calculateMarketSummary({
    probability,
    tradePlan,
    decisionEngine,
    recommendation
  });
   
    res.status(200).json({
      ok: true,
      source: "CoinGecko + OKX + CoinGlass V4",
      
     dataErrors: {
        coinGlass: coinGlass.errors
      },
      
      symbol,
      coin: coin.name,
      asset: coin.symbol.toUpperCase(),
      rank: coin.market_cap_rank,

       coinGlass,
      
      derivativesHistory,
        
      okxKlines: {
  available: okxDailyResponse.ok,
  source: "OKX",
  interval: "1D",
  candles: okxDailyCandles.length,

  latest:
    okxDailyCandles.length > 0
      ? okxDailyCandles[
          okxDailyCandles.length - 1
        ]
      : null,

  error: okxDailyResponse.ok
    ? null
    : okxDailyResponse.error
},
      
      fearGreed: {
          value: fgData.data[0].value,
          classification: fgData.data[0].value_classification
}, 
      
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
    decisionEngine,
    recommendation,
    marketBias,
    marketEnvironment,
    tradeReadiness,
    marketSummary  
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
