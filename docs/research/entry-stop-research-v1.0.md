# Entry/Stop Research Execution Protocol v1.0

Status: **PREREGISTERED**
**SIMULATION STILL NOT STARTED**

Created at: 2026-10-15T10:04:32.086641Z (documentation creation time, not snapshot/activation time).
Archive SHA-256: `ab17a8429926a3cd6a21e96aa7883f2f64e0fdb4a45518de3309ce82cf28bac2`
Config SHA-256: `0f14306352dd30abe08bbafc7b87058dd52dbb4b300faa5196d7146676c614c1`
Backend baseline: `ce487c11d0d899e63cbfa568958a2fc2c73dc5c9`.

## Integrity and scope

Verified locally: 97 unique records, 91 completed finite-result trades, 6 nonterminal; Legacy 69, New 22; Long 84, Short 7; 42 completed symbols. Signal range: 2026-09-17T17:24:53.835Z through 2026-10-08T13:24:52.767Z. The exact completed tradeIds are frozen in the config. All 91 origin.detectedAt equal initialPlan.createdAt.

This is a completion-selected historical research cohort, not an unbiased sample of all signals. Historical findings cannot activate real money, enter Forward, modify Core or authorize parameter search. Original lifecycle outcomes are not inputs to research plan construction.

## Normative config and hashing

The adjacent JSON is the machine-readable normative execution specification together with the frozen requirements below. Canonicalization: recursive lexicographic object-key ordering; arrays retain order; UTF-8 JSON; no whitespace; no trailing newline in hash input; finite JSON numbers only. Config hash is external to config to avoid self-reference. The file's pretty-printed byte hash is not the canonical config hash. A simulator must verify archive/config hashes and refuse unapproved versions. No simulator exists in this task.

## Frozen execution fee — Phase R2.2

CONSERVATIVE MODEL FEE ASSUMPTION, explicitly approved by the user on 2026-10-15:

- ENTRY FEE RATE = 0.0005 (0.05% per executed side).
- EXIT FEE RATE = 0.0005 (0.05% per executed side).
- VERIFIED CURRENT ACCOUNT FEE: UNKNOWN.
- This is not a verified universal/current Binance fee or a claim about historical account fills.

The [official Binance FAQ](https://www.binance.com/en-PH/support/faq/detail/360033544231), reviewed 2026-10-15 during R2.1, contains hypothetical maker 0.02% / taker 0.05% examples. The current official fee table could not be reliably retrieved. No new external verification was performed for R2.2. The rate is frozen by explicit research-model approval, not by treating that example as a verified account tariff.

No VIP, BNB, referral or account-specific discount; no assumed maker execution. Candle-touch evidence does not prove queue position or maker fills. Prior round-trip sensitivity scenarios are not adopted.

```text
feeUsd(side) = executedNotionalUsd * 0.0005
totalFeeUsd = entryExecutedNotionalUsd * 0.0005
            + exitExecutedNotionalUsd * 0.0005
feeR = totalFeeUsd / initialRiskUsd
MODEL NET R = MODEL GROSS R - feeR
```

Use actual MODEL execution prices for each executed notional. Do not implement a flat 0.10% deduction and do not multiply by leverage again. UNFILLED and INVALIDATED_UNFILLED incur zero execution fee. AMBIGUOUS, DATA_UNAVAILABLE and UNRESOLVED_OPEN have no fabricated completed Net R; an entry fee alone is not a completed outcome.

Funding remains EXCLUDED, an explicit limitation. Slippage remains ordinary touch at level price, active-stop gap at candle open, ambiguous entry gap AMBIGUOUS_ENTRY, with no arbitrary percentage addition. These rules are unchanged.

This section supersedes ONLY the pending fee/status instructions in the preserved original R2 text below. All other research parameters remain frozen unchanged. Preregistration is complete; candle download and simulation are not authorized by this task.

## Deterministic clarifications (no outcomes inspected)

- V0/V2 use fixed planned-entry level touch, not historical actual entry or zone-touch replay. All four use synthetic EXIT B; V0 is not exact Core lifecycle reproduction.
- Minute timestamps are interval opens. Strictly after cutoff means floor(cutoff/60s)*60s+60s even at an exact minute. Only wholly eligible confirmed candles are usable. No use of post-expiry/post-horizon partial-minute OHLC. If that partial minute is needed to distinguish a state, mark unresolved rather than zero.
- Research ATR is the unrounded arithmetic mean of 14 contiguous source-aligned closed 1D high-low ranges. Core's six-significant-digit formatting is not applied; this is the explicitly defined research measure. Verify OKX 1D alignment, do not silently substitute UTC daily bars.
- All prices must be positive finite and directionally valid. V3 must validate its structural stop against its own pullback entry, even if V2 was valid. No fallback or clamping.
- Filled-at-open is provable only when open equals planned entry under the fixed-level model. On other fill candles, any reachable exit level is conservatively ambiguous. A favorable gap without an observed touch is ambiguous, not a fabricated limit fill. Stop-only before possible fill invalidates, with missing-path/gap uncertainty taking precedence.
- Already-open gaps through SL execute at open; a candle opening at/beyond TP executes at TP without price improvement. Otherwise both levels touched is ambiguous. These are model rules, not exchange-fill claims.
- Random control uses V0 geometry only, same direction and original 72h horizon. Uniform minute selection with replacement from the first eligible minute to expiry is based on timestamps, never subsequent performance. Missing selected data remain missing; do not redraw. Translate fixed V0 distances around selected open. This market-at-random-open sanity control is deliberately distinct from the strategy's limit-entry mechanism.
- Rates use original cohort denominator, with missing/ambiguous counts visible. Strict comparisons use the common all-four resolved intersection and separate policy strata. Show observed denominator; do not label it the full 91-signal mean. Conditional-on-fill is secondary. Unbounded gap loss means a finite conservative lower bound may not exist; report N/A rather than invent one.
- Bootstrap resamples whole UTC days and computes pooled trade means (not equally weighted daily means); identical draws across variants. Type 7 h=(n-1)p, linear interpolation. Independent deterministic RNG streams as configured. Drawdown is descriptive realized-R drawdown on resolved outcomes, ordered by execution timestamp/tradeId, not mark-to-market equity.
- No fixed 46% acceptance criterion. The barrier formula assumes a driftless continuous martingale and suitable absorption; it is not a crypto-market guarantee. The -0.269R synthetic calculation assumes the remainder is always exactly zero and does not describe SM1M HOLD/CLOSE.

## Readiness

Fee assumption is now frozen by Phase R2.2; status PREREGISTERED, SIMULATION STILL NOT STARTED. Historical candle availability, instrument mapping/session alignment and data continuity are unverified empirical prerequisites, not permission to change parameters. No download or simulation authorized. CORE FROZEN; REAL-MONEY HOLD; FORWARD NOT STARTED; SHADOW PAUSED. No activation timestamp set.

## Frozen approved requirements (verbatim)

The following preserves the complete approved R2 requirements, including formulas, limits, anti-overfitting constraints and task boundaries.

```text
SM1M — ENTRY/STOP RESEARCH v1
PHASE R2 — PREREGISTER RESEARCH EXECUTION PROTOCOL v1.0

DOCUMENTATION / PREREGISTRATION TASK.

DO NOT DOWNLOAD CANDLES.
DO NOT RUN SIMULATION.
DO NOT CALCULATE V0/V1/V2/V3 RESULTS.
DO NOT SEARCH PARAMETERS.
DO NOT MODIFY CORE TRADING LOGIC.

CONTEXT

Backend HEAD / origin/main:
ce487c11d0d899e63cbfa568958a2fc2c73dc5c9

Core: FROZEN
Real-money: HOLD
Forward cohort: NOT STARTED
Forward Shadow development: PAUSED after B2.

Historical exploratory analysis was CLOSED.

One narrow exception is now approved:

HISTORICAL ENTRY/STOP RESEARCH v1

Purpose:
evaluate Entry + Stop geometry under one preregistered experiment.

This research is exploratory only.

It cannot:
- activate real-money trading
- directly modify Core
- justify retroactive parameter optimization
- justify selecting profitable symbols/dates
- enter Forward cohort

Any useful hypothesis must later be prospectively validated.

==================================================
1. SOURCE ARCHIVE
==================================================

Freeze the research archive:

/Users/polusmak/analysis/validation/archive-export-20261008.json

Expected SHA-256:

ab17a8429926a3cd6a21e96aa7883f2f64e0fdb4a45518de3309ce82cf28bac2

Freeze cohort:

97 unique tradeIds
91 completed terminal trades
6 nonterminal

Primary historical research cohort:
the same fixed 91 completed trades.

Expected:
Legacy completed = 69
New completed = 22
Long = 84
Short = 7
unique completed symbols = 42

Signal range by origin.detectedAt:
2026-09-17T17:24:53.835Z
through
2026-10-08T13:24:52.767Z

Verify these facts only.

If archive hash or cohort identity differs:

STOP.

Do not substitute another archive.

Document explicitly:

This is a completion-selected historical research cohort,
not an unbiased sample of all signals.

==================================================
2. RESEARCH DECISION CUTOFF
==================================================

Freeze:

researchDecisionCutoffAt = origin.detectedAt

Require:

origin.detectedAt valid
initialPlan.createdAt valid
origin.detectedAt == initialPlan.createdAt

If conflict:
signal is DATA_UNAVAILABLE for counterfactual plan construction.

Plan construction may use:

- frozen facts created at that signal
- external historical candles fully CLOSED by cutoff

Plan construction MUST NOT use:

- actual model entry
- activatedAt
- future lifecycle events
- TP/SL outcomes
- terminal timestamp
- later reanalysis
- later market observations

==================================================
3. RESEARCH PURPOSE
==================================================

Primary question:

Does a preregistered change to Entry and/or Stop geometry improve
mean R per ORIGINAL SIGNAL relative to the current frozen
Entry/Stop geometry under ONE COMMON reproducible exit policy?

This first experiment intentionally does NOT attempt to reproduce
actual SM1M post-TP1 HOLD/CLOSE behavior.

==================================================
4. COMMON EXIT POLICY
==================================================

Freeze:

EXIT B = 100% CLOSE AT TP1

Use EXIT B for V0, V1, V2 and V3.

Reason:

historical fresh post-TP1 analysis stream is insufficient to
reconstruct counterfactual HOLD/CLOSE decisions without hindsight.

Do NOT use historical lastReanalysis to fabricate counterfactual
decisions.

Actual SM1M EXIT A remains unchanged in Core.

Research EXIT B is synthetic research policy only.

==================================================
5. CORE-STYLE ATR
==================================================

For research geometry use:

Core-style ATR14 =
mean(high - low)
of the last 14 fully closed 1D candles available by
researchDecisionCutoffAt.

This is NOT Wilder True Range ATR.

Daily session alignment must match the historical market data
semantics used by the source.

If 14 valid fully closed daily candles cannot be reconstructed:

ATR_UNAVAILABLE

No fallback ATR.

==================================================
6. V0 — CONTROL
==================================================

V0:

Entry:
original frozen planned Entry
(initialPlan.entryPrice)

Stop:
original frozen initial SL

TP:
for the common research execution model use:

LONG:
Entry + 1.075 × Core-style ATR14

SHORT:
Entry - 1.075 × Core-style ATR14

IMPORTANT:

Also preserve the original frozen TP1 separately for diagnostic
comparison.

Do not silently substitute original frozen TP1 into the common
research model.

R denominator:

abs(Entry - Stop)

If geometry invalid:
GEOMETRY_UNAVAILABLE.

==================================================
7. V1 — PULLBACK ENTRY
==================================================

Freeze pullback parameter:

alpha = 0.25

Let:

d = +1 for LONG
d = -1 for SHORT

E0 = original frozen planned Entry
S0 = original frozen initial SL
R0 = abs(E0 - S0)

V1 Entry:

E1 = E0 - d × 0.25 × R0

V1 Stop:

S1 = S0

V1 TP:

LONG:
E1 + 1.075 × Core-style ATR14

SHORT:
E1 - 1.075 × Core-style ATR14

R denominator:

abs(E1 - S1)

Do not clamp E1 back into original Entry Zone.

This is a counterfactual pullback hypothesis.

==================================================
8. V2 — STRUCTURAL STOP
==================================================

Freeze structural definition:

TIMEFRAME:
1H

WINDOW:
last 12 fully closed 1H candles with closeTime <=
researchDecisionCutoffAt

LONG:
structural reference =
minimum LOW of those 12 candles

SHORT:
structural reference =
maximum HIGH of those 12 candles

Freeze buffer:

buffer = 0.10 × Core-style ATR14

V2 Entry:

E2 = original frozen planned Entry

V2 Stop:

LONG:
structuralLow - buffer

SHORT:
structuralHigh + buffer

V2 TP:

LONG:
E2 + 1.075 × Core-style ATR14

SHORT:
E2 - 1.075 × Core-style ATR14

R denominator:

abs(E2 - S2)

If structural stop is not strictly on the stop side of Entry:

STRUCTURE_UNAVAILABLE

No fallback to original SL.

Do not search for another pivot/window.

==================================================
9. V3 — COMBINED
==================================================

V3 uses:

Entry = V1 pullback Entry
Stop = V2 structural Stop

TP:

LONG:
V3 Entry + 1.075 × Core-style ATR14

SHORT:
V3 Entry - 1.075 × Core-style ATR14

R denominator:

abs(V3 Entry - V3 Stop)

If either V1 Entry or V2 structural stop is unavailable:

V3 unavailable.

==================================================
10. ORDER ACTIVATION
==================================================

No hypothetical research order may fill using information from the
minute containing researchDecisionCutoffAt.

Freeze:

firstEligibleMinute =
first complete 1m candle whose interval begins AFTER
researchDecisionCutoffAt

Use exact candle interval semantics.

Do not treat API candle timestamp as closeTime unless verified.

V0/V2 current-entry research order and V1/V3 pullback limit order
all obey the same no-backfill rule.

==================================================
11. ENTRY EXPIRY
==================================================

Freeze entry expiry:

12 HOURS after researchDecisionCutoffAt.

If entry is not validly filled by expiry:

UNFILLED

Primary gross contribution:

0R

Do not extend expiry because a later price would fill.

==================================================
12. TOTAL OUTCOME HORIZON
==================================================

Freeze total research horizon:

72 HOURS after researchDecisionCutoffAt.

Do NOT use the historical Core terminal timestamp to end a
counterfactual trade.

If position remains open at 72h:

UNRESOLVED_OPEN

Do NOT force-close at horizon in v1.0.

UNRESOLVED_OPEN is NOT 0R.

==================================================
13. EXECUTION TIMEFRAME
==================================================

Outcome execution timeframe:

1m confirmed/closed candles.

Pre-signal structural context:

1H confirmed/closed candles.

ATR reconstruction:

1D confirmed/closed candles.

Do not use:
5m
15m
4H

unless v1.0 is superseded before results are viewed.

==================================================
14. LIMIT / TOUCH MODEL
==================================================

Research model is a deterministic candle-touch model.

It does NOT claim exchange queue/fill realism.

A level may only execute if the candle data proves the level was
reachable after order activation.

No price improvement may be invented.

For an ordinary touched limit:

model fill price = preregistered Entry level

unless the gap rule below applies.

==================================================
15. GAP-THROUGH ENTRY
==================================================

Freeze conservative deterministic rule.

If the first eligible candle opens beyond the limit in the favorable
direction such that the limit would already have been crossed between
observations:

do NOT invent a better fill.

Use the preregistered Entry price only if execution at that price is
consistent with the candle path constraints.

Otherwise:

AMBIGUOUS_ENTRY

Do not choose a favorable open/limit price after seeing outcome.

If exact gap semantics cannot be represented reliably from 1m OHLC,
mark ambiguous.

==================================================
16. STOP BEFORE FILL
==================================================

For an unfilled order:

If a 1m candle proves the counterfactual Stop was reached before any
possible Entry fill:

INVALIDATED_UNFILLED

Primary gross contribution:
0R

If Entry and Stop are both reachable in the same 1m candle and their
order cannot be established:

AMBIGUOUS

Do not assume Entry first.

==================================================
17. POST-FILL SL / TP
==================================================

After valid fill:

SL and TP1 are active according to the fixed research plan.

If only SL touched:
stop result.

If only TP touched:
TP result.

If both SL and TP reachable in the same 1m candle and ordering cannot
be proven:

AMBIGUOUS

Do NOT choose:
TP-first
or
SL-first

for the primary result.

==================================================
18. GAP THROUGH STOP
==================================================

If an already-open position begins a 1m candle beyond its stop:

use candle OPEN as model stop execution price.

This allows loss worse than -1R.

Do not clamp to -1R.

This is a simple conservative gap/slippage rule.

==================================================
19. MISSING DATA
==================================================

Require continuous valid candles for the portion of the path needed
to establish the result.

Detect:

missing candle
duplicate candle
invalid OHLC
unconfirmed candle
instrument mismatch
timestamp disorder
unexplained market-data gap

Do not interpolate.

If the missing segment could affect Entry/SL/TP ordering:

DATA_UNAVAILABLE / UNRESOLVED

Do not assign 0R.

==================================================
20. DELISTING / MARKET UNAVAILABLE
==================================================

If required historical market data do not exist because instrument
mapping, listing history, delisting or API availability cannot be
established:

DATA_UNAVAILABLE

Do not convert this to:

UNFILLED
LOSS
0R

==================================================
21. PRIMARY R
==================================================

For every variant:

initialRiskPrice =
abs(model Entry - model Stop)

Gross R:

LONG:
(exitPrice - Entry) / initialRiskPrice

SHORT:
(Entry - exitPrice) / initialRiskPrice

For TP:
this may differ between V0–V3 because structural stop changes the R
denominator.

UNFILLED:
0 gross R.

INVALIDATED_UNFILLED:
0 gross R.

AMBIGUOUS:
not 0.

DATA_UNAVAILABLE:
not 0.

UNRESOLVED_OPEN:
not 0.

==================================================
22. FEES — DO NOT INVENT RATE
==================================================

Before simulation determine whether this project contains an already
frozen/known applicable Binance Futures fee assumption.

Search LOCAL project/research/docs only.

NO WEB.
NO ACCOUNT/API REQUESTS.

If an applicable fee rate is found:
report source and semantics, but do NOT silently adopt it unless the
protocol can prove it was previously fixed for this research.

If no suitable fixed rate exists:

set:

FEE_RATE = NOT YET FROZEN

and mark protocol:

NOT READY FOR SIMULATION

Do not invent 0.04%, 0.05% or another rate.

Funding:

EXCLUDED in v1.0.

This exclusion must be reported as a limitation.

==================================================
23. SLIPPAGE
==================================================

Do not add an arbitrary constant slippage percentage.

v1.0 price model:

- ordinary level touch: level price
- gap through active stop: candle open
- ambiguous gap-through entry: AMBIGUOUS_ENTRY

Any additional slippage model requires a future protocol version
before results.

==================================================
24. PRIMARY METRIC
==================================================

Freeze primary metric:

MEAN MODEL NET R PER ORIGINAL SIGNAL

But it may only be calculated once fee rate is frozen.

Also always report:

MEAN MODEL GROSS R PER ORIGINAL SIGNAL

Treatment:

UNFILLED = 0R
INVALIDATED_UNFILLED = 0R

AMBIGUOUS / DATA_UNAVAILABLE / UNRESOLVED_OPEN:
must NOT be silently treated as 0.

For incomplete outcomes report:

- observed paired estimate
- attrition/unresolved count
- conservative bounds where mathematically defensible

Do not hide denominator changes.

==================================================
25. SECONDARY METRICS
==================================================

Pre-register:

Total Gross R
Total Net R
Median R
Fill rate
TP-before-stop rate
Stop-before-TP rate
Unfilled rate
Invalidated-unfilled rate
Ambiguous rate
Data-unavailable rate
Unresolved-open rate
Mean R conditional on fill
descriptive Max Drawdown R

Do not optimize on any secondary metric.

==================================================
26. PAIRED COMPARISON
==================================================

V0/V1/V2/V3 comparisons are paired by original tradeId.

Do not compare changing convenience samples.

For strict paired estimates:

include only tradeIds for which all compared variants have the
required valid outcome classification.

Also separately report attrition introduced by each variant.

Do not remove losses.

==================================================
27. DAY-CLUSTER BOOTSTRAP
==================================================

Freeze cluster:

UTC calendar day of origin.detectedAt.

Resample entire signal-day clusters.

For paired comparisons:
the same sampled days are applied to both variants.

Freeze:

bootstrap repetitions = 10,000
seed = 20261015
percentile method = Type 7
confidence interval = 95%

Primary bootstrap target:

paired difference in mean Gross R per original signal.

After fee rate is frozen also report paired Net R difference.

==================================================
28. RANDOM-ENTRY CONTROL
==================================================

This is simulator sanity control only.

Freeze seed:

20261015

Freeze:

100 random samples per eligible original signal,
subject to data availability.

Use:

same symbol
same direction
same preregistered research horizon
same execution rules
same stop/TP geometry ratio as the applicable control geometry

Random entry time must be selected only from valid candidate times
inside the predeclared historical window and must not depend on future
price outcomes.

Do NOT use random control to optimize V1/V2/V3.

The theoretical:

P(TP first) = 1 / (1+k)

with k approximately 1.162

is reference mathematics only.

Deviation from approximately 46% is NOT automatically simulator
failure.

==================================================
29. MATHEMATICAL BASELINE
==================================================

Document:

For a driftless continuous martingale between barriers:

Stop = -1R
TP = +kR

P(TP first) = 1 / (1+k)

For k ≈ 1.162:

P ≈ 46.25%.

Assumptions do not hold exactly for real crypto markets.

Also document:

The approximately -0.269R expectation for:

50% close at TP
remaining 50% always exactly 0

is a simplified synthetic calculation.

It is NOT the expected value of actual SM1M HOLD/CLOSE.

Do not use it as historical evidence.

==================================================
30. ANTI-OVERFITTING FREEZE
==================================================

After this protocol is frozen and candle outcomes are viewed:

DO NOT change within Research v1:

alpha = 0.25
structural timeframe = 1H
structural window = 12
buffer = 0.10 Core ATR
TP distance = 1.075 Core ATR
entry expiry = 12h
outcome horizon = 72h
execution TF = 1m
Exit B
ambiguity rules
bootstrap configuration
random seed/count

No:

grid search
threshold sweep
optimizer
ML
symbol selection
date selection
loser removal
“try 0.20 instead”
“try 24h instead”
post-result rule repair

Any change requires:

NEW protocol version
explicit reason
new research status

The v1 results remain preserved.

==================================================
31. CONFIG HASH
==================================================

Create a machine-readable research config inside the protocol or as a
separate NEW research config file if needed.

It must contain all frozen parameters.

Compute deterministic SHA-256 over canonical config.

Record:

protocol version
archive SHA
config SHA
creation timestamp

No activation timestamp is needed.

This is research preregistration, not Forward activation.

==================================================
32. FILE SCOPE
==================================================

Prefer creating ONLY documentation/config under a research-specific
location.

Do NOT modify:

api/market.js
Core modules
Forward modules
existing tests
existing docs unrelated to this research
scripts/research-a-plus-pullbacks.mjs

Suggested:

docs/research/entry-stop-research-v1.0.md

and only if useful:

docs/research/entry-stop-research-v1.0.json

No simulator code yet.

==================================================
33. VALIDATION
==================================================

Validate:

- archive exists
- archive SHA exact
- 97 unique / 91 completed / 6 nonterminal
- frozen config internally consistent
- JSON/config canonical hash reproducible
- no parameter remains ambiguous EXCEPT fee rate if no prior fixed
  applicable assumption exists
- no Core/Forward files changed

If fee rate remains unfrozen:

status must explicitly say:

PREREGISTERED EXCEPT FEE RATE
SIMULATION NOT AUTHORIZED

Do not download candles yet.

==================================================
34. RETURN
==================================================

Return:

1. exact files created
2. archive verification
3. exact V0/V1/V2/V3 definitions
4. cutoff
5. ATR definition
6. entry activation/expiry
7. horizon
8. structural definition
9. execution/ambiguity rules
10. R definitions
11. fee search result
12. funding/slippage treatment
13. primary/secondary metrics
14. paired comparison
15. bootstrap config
16. random-control config
17. anti-overfitting freeze
18. protocol/config SHA
19. protocol status
20. git diff --check
21. git status --short

Confirm:

CORE: FROZEN
REAL-MONEY: HOLD
FORWARD COHORT: NOT STARTED
FORWARD SHADOW DEVELOPMENT: PAUSED

CANDLE DOWNLOAD: NO
SIMULATION: NO
PARAMETER SEARCH: NO
NETWORK: NO
REDIS: NO
PROVIDER/API REQUESTS: NO

NO COMMIT.
NO PUSH.
NO DEPLOY.

STOP.
```
