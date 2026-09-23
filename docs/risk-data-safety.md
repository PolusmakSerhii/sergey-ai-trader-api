# Risk and execution-data safety v1

## Semantics and boundary

The existing recommendation.positionSize is suggested risk percent (0.5/1%) and
leverage text (2x–3x/3x–5x), not account size, margin allocation or quantity. No balance,
position sizing or account portfolio was present. Existing tracked trades are a shared
modelled ledger, not a user's broker account; do not substitute their count for account
exposure. Existing R results exclude fees/slippage/funding. No historical result is edited.

The new POST /api/market?mode=risk-manager accepts canonical tradeId and an explicit
user-declared account scenario: balance, riskPercent, maxOpenRiskPercent, maxTrades,
leverage, openRiskAmount, openTrades, usedMargin, asOf, confirmedCurrent. It reads the
stored frozen plan. It ignores client price/plan/confirmedAPlus. Inputs are not saved
or logged. The UI suggests 0.25% / 1% total / 2 trades / 1x; account/exposure fields are
blank, never assumed zero. Users must include pending reservations and all account
positions. The observation expires after 60 seconds. Configuration is per request,
not a global shared Redis account configuration.

Risk = balance * riskPercent / 100. Distance = abs(referenceEntry - originalSL) /
referenceEntry. Notional = risk / distance. Margin = notional / leverage. Dollar SL
risk does not increase with leverage. Gross projected risk and simultaneous count
limits include the proposed trade. Margin check uses declared used margin.

READY means only this declared gross scenario passes; executionAuthorized is always
false. No broker integration, authoritative balance, atomic account reservation, exchange
margin tiers/leverage limits, contract quantity, fees, funding or slippage are invented.
Quantity/net risk remain null. Missing required configuration is UNAVAILABLE; invalid
geometry, portfolio limit breach, stale/incompatible critical data or outside frozen
zone is BLOCKED. Active plans return EXISTING_ACTIVE_TRADE, never a second entry.

Canonical A+ remains setup quality. Existing modelled registration and closed-1m
lifecycle remain unchanged, including Active frozen plans. UI new-entry readiness is
separately labelled Risk Check Required/Data Safety Blocked, not permission to trade.
Risk checks never write archive, trades, statistics, observations or Redis.

## Data source audit

* OKX 1D history-candles: confirmed flag/openTime; close=openTime+24h. Existing cache
  60s, 300-candle analysis unchanged. Safety checks valid OHLC, contiguous closed rows,
  matching instId/type, latest close age <=24h+5min. 1D uses OKX's UTC+8 session; no
  conversion to UTC calendar day is assumed. Future/missing timestamps fail closed.
* OKX ticker: exchange ts, max age 60s. SWAP analysis now uses SWAP ticker even for
  CoinGecko-mapped assets; SPOT fallback requests SPOT. Previously mapped assets used
  aggregated CoinGecko prices with SWAP candles, while fallback ticker always used SWAP.
  Correcting that input mismatch can change live analysis values; formulas are unchanged.
* CoinGecko: metadata retained; last_updated is available when returned. Aggregated USD
  price is not an OKX execution price. SPOT analysis using it is diagnosed incompatible,
  never promoted to execution-safe because response generation is fresh.
* CoinGlass: 60s response cache is retrieval caching, not observation freshness. Funding
  current has nextFundingTime (not observation time), aggregate OI/current liquidations
  lack a trusted sample timestamp in current normalized objects. L/S uses provider time;
  history uses 4h row time. Some pre-existing CoinGlass inputs influence Probability and
  Environment; their formulas are unchanged. New flow diagnostics do not influence scores.
* Fear/Greed: response timestamp, display/context only; not execution-price authority.

## Liquidations / OI diagnosis

24h liquidation flow requires exchange=All and finite nonnegative numeric long/short
amounts. Missing key/config/provider failure, missing All row or invalid fields produces
N/A, not zero. OI daily context requires six exact aligned 4h rows in the last confirmed
OKX daily window (you cannot replace missing rows with nearest samples). 4h optional
context uses Binance futures price vs aggregated OI; coverage difference remains explicit.
Provider failure, missing history, stale history and period mismatch have reason codes.
Unsupported-symbol cannot be proved solely from an empty response and is not guessed.
A particular production N/A incident requires its response; no production request was
made by this implementation. No removal of honest N/A or loosening freshness filters.

## Resource impact and limitations

Scanner adds no Redis calls. Mapped SWAP single-market analyses add one OKX ticker GET;
unmapped use the existing ticker request. Risk calculation: one open-trades GET, one
OKX SWAP ticker GET, one OKX daily history request (limit2, existing 60s process cache).
No provider/account authentication or credentials are exposed. No risk configuration
is attached retroactively to trades/archives. Concurrent read-only scenario checks
cannot reserve account risk; real-money execution still needs external account/order
controls. This is not a claim that automatic real-money trading is ready.
