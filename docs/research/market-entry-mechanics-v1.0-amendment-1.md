# Market Entry Mechanics v1.0 — Amendment 1 FINAL

PRE_OUTCOME. Updates the amendment previously committed at `0d4e7a90c05d77d95008ff934def98b7d9e9e397`; previous content remains in git history. Base protocol files remain unchanged. Only the explicit execution clarifications below supersede conflicting base wording. All other parameters and gates remain frozen.

No engine execution or historical dataset download is authorized by this document. Prior R7-A availability probes are distinct from collection of the research dataset; no historical outcomes were used for this amendment.

## Machine-readable contract

```json
{
  "protocolVersion": "market-entry-mechanics-v1.0-amendment-1",
  "baseProtocol": "market-entry-mechanics-v1.0",
  "baseProtocolCommit": "e3c73966e22e8e5637a76a60a07d34dd6e44b026",
  "baseMdSha256": "2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242",
  "baseJsonSha256": "76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c",
  "amendment": 1,
  "draftRevision": "FINAL",
  "amendmentTiming": "PRE_OUTCOME",
  "amendmentReason": [
    "Unknown WAITING_ENTRY intrabar ordering of EL and terminal barriers",
    "Opening gap through EL inside barriers had no explicit marketability rule",
    "Exact first execution candle and expiry equality previously unspecified"
  ],
  "historicalOutcomesInspected": false,
  "developmentOpened": false,
  "holdoutOpened": false,
  "scope": "Alternative WAITING_ENTRY only; all base rules remain frozen except these explicit clarifications",
  "openPriority": [
    {
      "priority": 1,
      "LONG": "Open <= S OR Open >= T",
      "SHORT": "Open >= S OR Open <= T",
      "result": "INVALIDATED_UNFILLED",
      "grossR": 0,
      "netR": 0,
      "fees": 0
    },
    {
      "priority": 2,
      "precondition": "Open strictly inside frozen barriers",
      "LONG": "Open <= EL",
      "SHORT": "Open >= EL",
      "result": "FILL_AT_OPEN_EVENT",
      "entryPrice": "EL",
      "nextState": "ACTIVE",
      "then": "same-candle ACTIVE intrabar rules"
    },
    {
      "priority": 3,
      "precondition": "neither invalidated nor filled at open",
      "result": "WAITING_ENTRY intrabar table"
    }
  ],
  "intrabarTable": {
    "scope": "still WAITING_ENTRY after OPEN; unknown intrabar order",
    "neither EL nor barrier": "remain WAITING_ENTRY until expiry",
    "EL only": "fill at EL -> ACTIVE",
    "S only": "INVALIDATED_UNFILLED",
    "T only": "INVALIDATED_UNFILLED",
    "EL+S": "INVALIDATED_UNFILLED",
    "EL+T": "INVALIDATED_UNFILLED",
    "EL+S+T": "INVALIDATED_UNFILLED"
  },
  "equalities": {
    "Open==S": "INVALIDATED_UNFILLED",
    "Open==T": "INVALIDATED_UNFILLED",
    "Open==EL inside barriers": "fill at EL -> ACTIVE"
  },
  "postOpenFill": {
    "Stop only": "STOP at S",
    "Target only": "TP at T",
    "Stop+Target unknown order": "STOP at S",
    "no barrier": "remain ACTIVE, subject to horizon",
    "laterIntrabarStopGap": false
  },
  "alreadyActive": "base ACTIVE rules; adverse opening stop gap at observed Open; target at T; no prefill cancellation",
  "expiry": "Alternative fill/invalidation requires openTime >= observationAt AND closeTime <= entryExpiry and valid confirmed candle; exclude partial expiry candle even if marketable at Open; waiting after last eligible candle -> UNFILLED, 0R, zero fees",
  "modelLimitation": "EL execution at open event is deterministic no-price-improvement convention, not a claim of actual exchange fill",
  "normativeSections": [
    {
      "section": 1,
      "title": "PURPOSE",
      "text": "Freeze three execution clarifications discovered BEFORE any historical\noutcomes were inspected:\n\nA. WAITING_ENTRY same-candle EL + terminal-barrier ambiguity.\n\nB. WAITING_ENTRY opening gap through EL while Open remains inside\n   frozen Stop/Target.\n\nC. Exact execution-window lower boundary and expiry inclusivity.\n\nAll other v1.0 parameters remain unchanged."
    },
    {
      "section": 2,
      "title": "EXACT EXECUTION WINDOW START",
      "text": "Observation:\n\nobservationAt = 17:00:00 UTC.\n\nP0 remains:\n\nclose of the final fully closed confirmed 1m candle with:\n\ncloseTime <= observationAt.\n\nFor normal 1m bars:\n\nP0 candle:\nopenTime  = 16:59:00\ncloseTime = 17:00:00\n\nFreeze the FIRST execution candle for BOTH Baseline and Alternative as:\n\nopenTime >= observationAt\n\nTherefore the first normal eligible execution candle is:\n\nopenTime  = 17:00:00\ncloseTime = 17:01:00\n\nThere is NO intentional one-minute gap.\n\nThe 17:00–17:01 candle may NOT define P0 or any frozen setup input.\n\nIts OHLC may be used only for post-cutoff execution/outcome modeling."
    },
    {
      "section": 3,
      "title": "BASELINE FIRST CANDLE",
      "text": "Baseline immediate model market entry uses:\n\nOpen of the first fully eligible confirmed 1m execution candle with:\n\nopenTime >= observationAt.\n\nUnder normal complete 1m data:\n\nEntry candle = 17:00–17:01\nEntry price = its Open at 17:00.\n\nExisting Baseline geometry rule remains:\n\nLONG:\nS < EB < T\n\nSHORT:\nT < EB < S\n\nOtherwise:\n\nINVALIDATED_UNFILLED\n0R\nfees 0."
    },
    {
      "section": 4,
      "title": "ALTERNATIVE FIRST CANDLE",
      "text": "Alternative may begin evaluating EL on the same first execution\ncandle:\n\nopenTime >= observationAt.\n\nThus 17:00–17:01 is eligible for Alternative fill/invalidation.\n\nNo candle before observationAt may establish Alternative fill."
    },
    {
      "section": 5,
      "title": "EXPIRY INCLUSIVITY",
      "text": "Alternative expiry:\n\nentryExpiry = observationAt + 4h.\n\nFreeze exact candle eligibility:\n\nA candle may establish Alternative fill/invalidation only if:\n\nopenTime >= observationAt\nAND\ncloseTime <= entryExpiry\nAND\nthe candle otherwise passes frozen validity/confirmation rules.\n\nTherefore for:\n\nobservationAt = 17:00\nentryExpiry = 21:00\n\nthe LAST eligible entry candle is:\n\nopenTime  = 20:59:00\ncloseTime = 21:00:00\n\nA candle:\n\n21:00–21:01\n\nis NOT entry-eligible.\n\nA candle crossing expiry is NOT partially evaluated for entry.\n\nIf still WAITING_ENTRY after processing the final eligible candle:\n\nUNFILLED\n0R\nfees 0."
    },
    {
      "section": 6,
      "title": "HORIZON — UNCHANGED",
      "text": "Outcome horizon remains:\n\nobservationAt + 12h.\n\nExisting frozen rule remains:\n\ncloseTime <= horizon.\n\nFor observation 17:00:\n\nhorizon = 05:00 next day\n\nlast eligible outcome candle:\n\n04:59–05:00.\n\nDo not change this rule."
    },
    {
      "section": 7,
      "title": "WAITING_ENTRY OPEN PRIORITY",
      "text": "For every eligible Alternative candle while WAITING_ENTRY:\n\nPROCESS OPEN EVENT FIRST.\n\nFrozen order:\n\n1. terminal-barrier invalidation\n2. marketable-at-open limit fill\n3. remaining intrabar processing."
    },
    {
      "section": 8,
      "title": "OPEN BARRIER INVALIDATION",
      "text": "LONG:\n\nif Open <= S OR Open >= T:\n    INVALIDATED_UNFILLED\n    Gross R = 0\n    Net R = 0\n    fees = 0\n\nSHORT:\n\nif Open >= S OR Open <= T:\n    INVALIDATED_UNFILLED\n    Gross R = 0\n    Net R = 0\n    fees = 0\n\nBarrier equality invalidates.\n\nNo position is opened."
    },
    {
      "section": 9,
      "title": "MARKETABLE-AT-OPEN LIMIT",
      "text": "Only if Open remains STRICTLY inside frozen S/T:\n\nLONG buy-limit EL:\n\nif Open <= EL:\n    FILLED at OPEN event\n    model Entry = frozen EL\n    state -> ACTIVE\n\nSHORT sell-limit EL:\n\nif Open >= EL:\n    FILLED at OPEN event\n    model Entry = frozen EL\n    state -> ACTIVE\n\nNo favorable price improvement.\n\nExamples:\n\nLONG:\nS=96\nEL=99\nT=104\nOpen=98\n\n=> Entry=99\n=> ACTIVE before intrabar processing.\n\nSHORT:\nT=96\nEL=101\nS=104\nOpen=102\n\n=> Entry=101\n=> ACTIVE before intrabar processing.\n\nOpen == EL:\n\nfill at EL -> ACTIVE."
    },
    {
      "section": 10,
      "title": "SAME-CANDLE AFTER OPEN FILL",
      "text": "If marketable-at-open fill occurred:\n\nthe position is ACTIVE before processing that candle's High/Low.\n\nThen existing ACTIVE rules apply to the SAME candle:\n\nStop only -> STOP at frozen Stop\nTarget only -> TP at frozen Target\nStop + Target -> STOP\nneither -> remain ACTIVE.\n\nDo not apply WAITING_ENTRY invalidation after a proven opening fill."
    },
    {
      "section": 11,
      "title": "WAITING_ENTRY INTRABAR PRIORITY",
      "text": "If Open:\n\n- did not invalidate setup;\n- did not establish marketable limit fill;\n\nthen evaluate intrabar range.\n\nWhen OHLC cannot establish intraminute ordering:\n\nEL only:\n    fill at EL -> ACTIVE\n\nS only:\n    INVALIDATED_UNFILLED\n\nT only:\n    INVALIDATED_UNFILLED\n\nEL + S:\n    INVALIDATED_UNFILLED\n\nEL + T:\n    INVALIDATED_UNFILLED\n\nEL + S + T:\n    INVALIDATED_UNFILLED\n\nThis applies symmetrically LONG and SHORT.\n\nPre-fill terminal-barrier invalidation has priority over possible limit\nfill when order is unknown.\n\nNo tick-path reconstruction.\n\nNo future candle may resolve previous intrabar ordering."
    },
    {
      "section": 12,
      "title": "ALREADY ACTIVE POSITIONS",
      "text": "WAITING_ENTRY rules do NOT apply to a position already ACTIVE before\nthe candle.\n\nExisting frozen ACTIVE rules remain:\n\n- adverse opening gap through Stop:\n  exit at observed adverse Open;\n\n- favorable opening gap through Target:\n  exit at frozen Target;\n\n- Stop only:\n  STOP;\n\n- Target only:\n  TP;\n\n- Stop + Target with unknown order:\n  STOP;\n\n- no terminal event by horizon:\n  TIME_EXIT."
    },
    {
      "section": 13,
      "title": "EXACT BOUNDARY EXAMPLES",
      "text": "Freeze explicitly:\n\nP0 candle:\n16:59–17:00\n\nFirst execution candle:\n17:00–17:01\n\nFirst execution open:\n17:00\n\nLast Alternative entry candle:\n20:59–21:00\n\n21:00–21:01:\nNOT entry eligible.\n\nLast outcome candle:\n04:59–05:00 next day.\n\nNo intentional one-minute delay after observationAt."
    },
    {
      "section": 14,
      "title": "PRE-OUTCOME STATUS",
      "text": "Record explicitly:\n\nAll three clarifications were made BEFORE:\n\n- historical candle download for this experiment;\n- Development outcome inspection;\n- Holdout outcome inspection;\n- generic simulator historical execution.\n\nHistorical outcomes inspected = false\nDevelopment opened = false\nHoldout opened = false\n\nThis amendment does NOT claim the deterministic OHLC execution policy\nreconstructs actual tick-level historical order.\n\nIt defines the research model."
    },
    {
      "section": 15,
      "title": "NO OTHER PARAMETER CHANGES",
      "text": "Do NOT change:\n\nUniverse:\nBTC-USDT-SWAP\nETH-USDT-SWAP\nSOL-USDT-SWAP\n\nObservation:\n17:00 UTC\n\nDevelopment:\n2024-11-01 through 2025-10-31 inclusive\n\nEmbargo:\n2025-11-01\n\nHoldout:\n2025-11-02 through 2026-04-30 inclusive\n\nATR:\nmean(high-low), last 14 fully closed confirmed OKX 1D candles,\n16:00 UTC alignment\n\nAlternative:\nP0 - d*0.25A\n\nStop:\nP0 - d*A\n\nTarget:\nP0 + d*A\n\nExpiry:\n4h\n\nHorizon:\n12h\n\nFee:\n0.0005 per executed side\n\nBootstrap:\n7-day moving blocks\n10,000 repetitions\nseed 20261016\nType-7 percentiles\n\nPrimary metric and advancement/holdout rules unchanged."
    }
  ],
  "designValidation": {
    "method": "logical synthetic design review only; no engine or historical execution",
    "cases": [
      {
        "id": 1,
        "case": "Open beyond Stop",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 2,
        "case": "Open == Stop",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 3,
        "case": "Open beyond Target",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 4,
        "case": "Open == Target",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 5,
        "case": "Open through EL inside barriers",
        "LONG": "fill at EL; ACTIVE before intrabar",
        "SHORT": "fill at EL; ACTIVE before intrabar",
        "status": "PASS"
      },
      {
        "id": 6,
        "case": "Open == EL",
        "LONG": "fill at EL; ACTIVE before intrabar",
        "SHORT": "fill at EL; ACTIVE before intrabar",
        "status": "PASS"
      },
      {
        "id": 7,
        "case": "Nonmarketable Open + EL only",
        "LONG": "fill at EL -> ACTIVE",
        "SHORT": "fill at EL -> ACTIVE",
        "status": "PASS"
      },
      {
        "id": 8,
        "case": "S only",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 9,
        "case": "T only",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 10,
        "case": "EL+S",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 11,
        "case": "EL+T",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 12,
        "case": "EL+S+T",
        "LONG": "INVALIDATED_UNFILLED",
        "SHORT": "INVALIDATED_UNFILLED",
        "status": "PASS"
      },
      {
        "id": 13,
        "case": "Opening fill then Stop",
        "LONG": "STOP at S",
        "SHORT": "STOP at S",
        "status": "PASS"
      },
      {
        "id": 14,
        "case": "Opening fill then Target",
        "LONG": "TP at T",
        "SHORT": "TP at T",
        "status": "PASS"
      },
      {
        "id": 15,
        "case": "Opening fill then Stop+Target",
        "LONG": "STOP at S",
        "SHORT": "STOP at S",
        "status": "PASS"
      },
      {
        "id": 16,
        "case": "Exact observation boundary",
        "LONG": "17:00-17:01 eligible; P0 is 16:59-17:00",
        "SHORT": "17:00-17:01 eligible; P0 is 16:59-17:00",
        "status": "PASS"
      },
      {
        "id": 17,
        "case": "Exact expiry boundary",
        "LONG": "20:59-21:00 entry eligible",
        "SHORT": "20:59-21:00 entry eligible",
        "status": "PASS"
      },
      {
        "id": 18,
        "case": "First candle after expiry",
        "LONG": "21:00-21:01 not entry eligible",
        "SHORT": "21:00-21:01 not entry eligible",
        "status": "PASS"
      },
      {
        "id": 19,
        "case": "Exact horizon boundary",
        "LONG": "04:59-05:00 eligible; TIME_EXIT if still ACTIVE without earlier terminal event",
        "SHORT": "04:59-05:00 eligible; TIME_EXIT if still ACTIVE without earlier terminal event",
        "status": "PASS"
      }
    ],
    "note": "S-only after nonmarketable inside-barrier open cannot occur without EL crossing for valid OHLC; prescribed defensive classification retained. Baseline missing required first candle remains a data failure, not permission to skip it.",
    "anotherBlockerFound": false
  },
  "noImplementation": true,
  "revisionHistory": {
    "previousCommit": "0d4e7a90c05d77d95008ff934def98b7d9e9e397",
    "previousHashes": {
      "market-entry-mechanics-v1.0-amendment-1.json": "e5fd579473bc6135de09898de0d95cb69c30182f734a011384ac71ad52e41730",
      "market-entry-mechanics-v1.0-amendment-1.md": "db23987d6a1bdb33fb3beb7722b0e52d190c4b4038ddb6963a69b64b4f116548"
    },
    "change": "Pre-outcome finalization: exact execution start and expiry inclusivity; prior open/intrabar rules preserved"
  },
  "executionWindow": {
    "firstEligibleOpenTime": "openTime >= observationAt",
    "entryEligibleCloseTime": "closeTime <= entryExpiry",
    "outcomeEligibleCloseTime": "closeTime <= horizon",
    "appliesTo": [
      "Baseline",
      "Alternative"
    ],
    "observationUTC": "17:00:00",
    "P0Candle": {
      "openUTC": "16:59:00",
      "closeUTC": "17:00:00"
    },
    "firstExecutionCandle": {
      "openUTC": "17:00:00",
      "closeUTC": "17:01:00"
    },
    "lastEntryCandle": {
      "openUTC": "20:59:00",
      "closeUTC": "21:00:00"
    },
    "lastOutcomeCandle": {
      "openUTC": "04:59:00 next day",
      "closeUTC": "05:00:00 next day"
    },
    "intentionalOneMinuteGap": false,
    "executionOHLCMayDefineSetup": false,
    "validConfirmedCandlesRequired": true
  }
}
```

## Normative amendment

### 1. PURPOSE

Freeze three execution clarifications discovered BEFORE any historical
outcomes were inspected:

A. WAITING_ENTRY same-candle EL + terminal-barrier ambiguity.

B. WAITING_ENTRY opening gap through EL while Open remains inside
   frozen Stop/Target.

C. Exact execution-window lower boundary and expiry inclusivity.

All other v1.0 parameters remain unchanged.

### 2. EXACT EXECUTION WINDOW START

Observation:

observationAt = 17:00:00 UTC.

P0 remains:

close of the final fully closed confirmed 1m candle with:

closeTime <= observationAt.

For normal 1m bars:

P0 candle:
openTime  = 16:59:00
closeTime = 17:00:00

Freeze the FIRST execution candle for BOTH Baseline and Alternative as:

openTime >= observationAt

Therefore the first normal eligible execution candle is:

openTime  = 17:00:00
closeTime = 17:01:00

There is NO intentional one-minute gap.

The 17:00–17:01 candle may NOT define P0 or any frozen setup input.

Its OHLC may be used only for post-cutoff execution/outcome modeling.

### 3. BASELINE FIRST CANDLE

Baseline immediate model market entry uses:

Open of the first fully eligible confirmed 1m execution candle with:

openTime >= observationAt.

Under normal complete 1m data:

Entry candle = 17:00–17:01
Entry price = its Open at 17:00.

Existing Baseline geometry rule remains:

LONG:
S < EB < T

SHORT:
T < EB < S

Otherwise:

INVALIDATED_UNFILLED
0R
fees 0.

### 4. ALTERNATIVE FIRST CANDLE

Alternative may begin evaluating EL on the same first execution
candle:

openTime >= observationAt.

Thus 17:00–17:01 is eligible for Alternative fill/invalidation.

No candle before observationAt may establish Alternative fill.

### 5. EXPIRY INCLUSIVITY

Alternative expiry:

entryExpiry = observationAt + 4h.

Freeze exact candle eligibility:

A candle may establish Alternative fill/invalidation only if:

openTime >= observationAt
AND
closeTime <= entryExpiry
AND
the candle otherwise passes frozen validity/confirmation rules.

Therefore for:

observationAt = 17:00
entryExpiry = 21:00

the LAST eligible entry candle is:

openTime  = 20:59:00
closeTime = 21:00:00

A candle:

21:00–21:01

is NOT entry-eligible.

A candle crossing expiry is NOT partially evaluated for entry.

If still WAITING_ENTRY after processing the final eligible candle:

UNFILLED
0R
fees 0.

### 6. HORIZON — UNCHANGED

Outcome horizon remains:

observationAt + 12h.

Existing frozen rule remains:

closeTime <= horizon.

For observation 17:00:

horizon = 05:00 next day

last eligible outcome candle:

04:59–05:00.

Do not change this rule.

### 7. WAITING_ENTRY OPEN PRIORITY

For every eligible Alternative candle while WAITING_ENTRY:

PROCESS OPEN EVENT FIRST.

Frozen order:

1. terminal-barrier invalidation
2. marketable-at-open limit fill
3. remaining intrabar processing.

### 8. OPEN BARRIER INVALIDATION

LONG:

if Open <= S OR Open >= T:
    INVALIDATED_UNFILLED
    Gross R = 0
    Net R = 0
    fees = 0

SHORT:

if Open >= S OR Open <= T:
    INVALIDATED_UNFILLED
    Gross R = 0
    Net R = 0
    fees = 0

Barrier equality invalidates.

No position is opened.

### 9. MARKETABLE-AT-OPEN LIMIT

Only if Open remains STRICTLY inside frozen S/T:

LONG buy-limit EL:

if Open <= EL:
    FILLED at OPEN event
    model Entry = frozen EL
    state -> ACTIVE

SHORT sell-limit EL:

if Open >= EL:
    FILLED at OPEN event
    model Entry = frozen EL
    state -> ACTIVE

No favorable price improvement.

Examples:

LONG:
S=96
EL=99
T=104
Open=98

=> Entry=99
=> ACTIVE before intrabar processing.

SHORT:
T=96
EL=101
S=104
Open=102

=> Entry=101
=> ACTIVE before intrabar processing.

Open == EL:

fill at EL -> ACTIVE.

### 10. SAME-CANDLE AFTER OPEN FILL

If marketable-at-open fill occurred:

the position is ACTIVE before processing that candle's High/Low.

Then existing ACTIVE rules apply to the SAME candle:

Stop only -> STOP at frozen Stop
Target only -> TP at frozen Target
Stop + Target -> STOP
neither -> remain ACTIVE.

Do not apply WAITING_ENTRY invalidation after a proven opening fill.

### 11. WAITING_ENTRY INTRABAR PRIORITY

If Open:

- did not invalidate setup;
- did not establish marketable limit fill;

then evaluate intrabar range.

When OHLC cannot establish intraminute ordering:

EL only:
    fill at EL -> ACTIVE

S only:
    INVALIDATED_UNFILLED

T only:
    INVALIDATED_UNFILLED

EL + S:
    INVALIDATED_UNFILLED

EL + T:
    INVALIDATED_UNFILLED

EL + S + T:
    INVALIDATED_UNFILLED

This applies symmetrically LONG and SHORT.

Pre-fill terminal-barrier invalidation has priority over possible limit
fill when order is unknown.

No tick-path reconstruction.

No future candle may resolve previous intrabar ordering.

### 12. ALREADY ACTIVE POSITIONS

WAITING_ENTRY rules do NOT apply to a position already ACTIVE before
the candle.

Existing frozen ACTIVE rules remain:

- adverse opening gap through Stop:
  exit at observed adverse Open;

- favorable opening gap through Target:
  exit at frozen Target;

- Stop only:
  STOP;

- Target only:
  TP;

- Stop + Target with unknown order:
  STOP;

- no terminal event by horizon:
  TIME_EXIT.

### 13. EXACT BOUNDARY EXAMPLES

Freeze explicitly:

P0 candle:
16:59–17:00

First execution candle:
17:00–17:01

First execution open:
17:00

Last Alternative entry candle:
20:59–21:00

21:00–21:01:
NOT entry eligible.

Last outcome candle:
04:59–05:00 next day.

No intentional one-minute delay after observationAt.

### 14. PRE-OUTCOME STATUS

Record explicitly:

All three clarifications were made BEFORE:

- historical candle download for this experiment;
- Development outcome inspection;
- Holdout outcome inspection;
- generic simulator historical execution.

Historical outcomes inspected = false
Development opened = false
Holdout opened = false

This amendment does NOT claim the deterministic OHLC execution policy
reconstructs actual tick-level historical order.

It defines the research model.

### 15. NO OTHER PARAMETER CHANGES

Do NOT change:

Universe:
BTC-USDT-SWAP
ETH-USDT-SWAP
SOL-USDT-SWAP

Observation:
17:00 UTC

Development:
2024-11-01 through 2025-10-31 inclusive

Embargo:
2025-11-01

Holdout:
2025-11-02 through 2026-04-30 inclusive

ATR:
mean(high-low), last 14 fully closed confirmed OKX 1D candles,
16:00 UTC alignment

Alternative:
P0 - d*0.25A

Stop:
P0 - d*A

Target:
P0 + d*A

Expiry:
4h

Horizon:
12h

Fee:
0.0005 per executed side

Bootstrap:
7-day moving blocks
10,000 repetitions
seed 20261016
Type-7 percentiles

Primary metric and advancement/holdout rules unchanged.

## Synthetic design review (not executable tests)

| Case | LONG | SHORT | Status |
|---|---|---|---|
| 1. Open beyond Stop | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 2. Open == Stop | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 3. Open beyond Target | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 4. Open == Target | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 5. Open through EL inside barriers | fill at EL; ACTIVE before intrabar | fill at EL; ACTIVE before intrabar | PASS |
| 6. Open == EL | fill at EL; ACTIVE before intrabar | fill at EL; ACTIVE before intrabar | PASS |
| 7. Nonmarketable Open + EL only | fill at EL -> ACTIVE | fill at EL -> ACTIVE | PASS |
| 8. S only | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 9. T only | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 10. EL+S | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 11. EL+T | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 12. EL+S+T | INVALIDATED_UNFILLED | INVALIDATED_UNFILLED | PASS |
| 13. Opening fill then Stop | STOP at S | STOP at S | PASS |
| 14. Opening fill then Target | TP at T | TP at T | PASS |
| 15. Opening fill then Stop+Target | STOP at S | STOP at S | PASS |
| 16. Exact observation boundary | 17:00-17:01 eligible; P0 is 16:59-17:00 | 17:00-17:01 eligible; P0 is 16:59-17:00 | PASS |
| 17. Exact expiry boundary | 20:59-21:00 entry eligible | 20:59-21:00 entry eligible | PASS |
| 18. First candle after expiry | 21:00-21:01 not entry eligible | 21:00-21:01 not entry eligible | PASS |
| 19. Exact horizon boundary | 04:59-05:00 eligible; TIME_EXIT if still ACTIVE without earlier terminal event | 04:59-05:00 eligible; TIME_EXIT if still ACTIVE without earlier terminal event | PASS |

S-only after nonmarketable inside-barrier open cannot occur without EL crossing for valid OHLC; prescribed defensive classification retained. Baseline missing required first candle remains a data failure, not permission to skip it.

No further blocker found in reviewed cases. Engine implementation and synthetic acceptance tests remain required in R7-C1.

CORE: FROZEN
REAL-MONEY: HOLD
R6: PAUSED
FORWARD: PAUSED
