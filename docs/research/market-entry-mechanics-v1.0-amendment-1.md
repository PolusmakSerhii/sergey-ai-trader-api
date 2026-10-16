# Market Entry Mechanics v1.0 — Pre-outcome Amendment 1

Revision 2 of the previously unfrozen amendment proposal. The previous attempt created no amendment files or commit.

Base protocol and its original hashes remain unchanged. This amendment explicitly supersedes only conflicting Alternative WAITING_ENTRY pre-fill priority/marketable-open semantics. It does not assert that cancellation is the worst realized outcome on every possible price path. All other base parameters and gates remain in force.

## Machine-readable contract

```json
{
  "protocolVersion": "market-entry-mechanics-v1.0-amendment-1",
  "baseProtocol": "market-entry-mechanics-v1.0",
  "baseProtocolCommit": "e3c73966e22e8e5637a76a60a07d34dd6e44b026",
  "baseMdSha256": "2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242",
  "baseJsonSha256": "76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c",
  "amendment": 1,
  "draftRevision": 2,
  "amendmentTiming": "PRE_OUTCOME",
  "amendmentReason": [
    "Unknown WAITING_ENTRY intrabar ordering of EL and terminal barriers",
    "Opening gap through EL inside barriers had no explicit marketability rule"
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
  "expiry": "fully eligible candle only; partial expiry candle excluded even when marketable at Open; remaining WAITING_ENTRY -> UNFILLED, 0R, zero fees",
  "modelLimitation": "EL execution at open event is deterministic no-price-improvement convention, not a claim of actual exchange fill",
  "normativeSections": [
    {
      "section": 2,
      "title": "SCOPE OF AMENDMENT",
      "text": "Clarify ONLY Alternative WAITING_ENTRY execution semantics.\n\nDo NOT change:\n\nuniverse\ncalendar\nobservation time\nP0\nATR\npullback 0.25A\nStop\nTarget\nexpiry\nhorizon\nfees\nprimary metric\nbootstrap\nDevelopment rule\nHoldout rule."
    },
    {
      "section": 3,
      "title": "WAITING_ENTRY OPEN-EVENT PRIORITY",
      "text": "For every eligible 1m candle while Alternative is WAITING_ENTRY:\n\nPROCESS CANDLE OPEN FIRST.\n\nLet:\n\nLONG:\nS < EL < T\n\nSHORT:\nT < EL < S\n\nFirst determine whether Open itself proves that a frozen terminal\nbarrier has already been reached/crossed before a valid new fill.\n\nBarrier invalidation has priority over opening limit fill.\n\nTherefore:\n\nLONG:\nif Open <= S OR Open >= T:\n    INVALIDATED_UNFILLED\n    Gross R = 0\n    Net R = 0\n    fees = 0\n\nSHORT:\nif Open >= S OR Open <= T:\n    INVALIDATED_UNFILLED\n    Gross R = 0\n    Net R = 0\n    fees = 0\n\nOnly if Open remains STRICTLY inside S/T may an opening limit fill be\nconsidered."
    },
    {
      "section": 4,
      "title": "MARKETABLE-AT-OPEN LIMIT",
      "text": "If state is WAITING_ENTRY and Open remains strictly inside frozen\nbarriers:\n\nLONG buy-limit EL:\n\nif Open <= EL:\n    limit is considered FILLED at the OPEN event.\n\nSHORT sell-limit EL:\n\nif Open >= EL:\n    limit is considered FILLED at the OPEN event.\n\nIMPORTANT MODEL EXECUTION PRICE:\n\nEntry = frozen EL\n\nNOT candle Open.\n\nThere is NO favorable price improvement.\n\nExamples:\n\nLONG:\nS=96\nEL=99\nT=104\nOpen=98\n\n=> opening barrier invalidation: NO\n=> marketable limit: YES\n=> Entry=99\n=> state ACTIVE before intrabar high/low processing.\n\nSHORT:\nT=96\nEL=101\nS=104\nOpen=102\n\n=> opening barrier invalidation: NO\n=> marketable limit: YES\n=> Entry=101\n=> state ACTIVE before intrabar high/low processing.\n\nThis is a deterministic research execution convention.\nIt is NOT a claim about exact historical exchange fill price."
    },
    {
      "section": 5,
      "title": "AFTER OPEN-EVENT FILL",
      "text": "Once marketable-at-open fill is established:\n\nstate becomes ACTIVE immediately.\n\nThen process the SAME candle's remaining intrabar high/low under\nACTIVE rules.\n\nTherefore:\n\nStop only touched after open -> STOP\nTarget only -> TP\nStop + Target with unknown order -> STOP\n\nAdverse Stop gap cannot occur later inside that same candle because\nthe candle Open has already been processed; ordinary Stop touch uses\nfrozen Stop.\n\nNo favorable Target improvement."
    },
    {
      "section": 6,
      "title": "WAITING_ENTRY INTRABAR RULES",
      "text": "If Open:\n\n- does not invalidate the setup; AND\n- does not make the limit marketable;\n\nthen process intrabar ranges.\n\nFor unknown intrabar order:\n\nEL only:\n    fill at frozen EL -> ACTIVE\n\nS only:\n    INVALIDATED_UNFILLED\n\nT only:\n    INVALIDATED_UNFILLED\n\nEL + S:\n    INVALIDATED_UNFILLED\n\nEL + T:\n    INVALIDATED_UNFILLED\n\nEL + S + T:\n    INVALIDATED_UNFILLED\n\nPre-fill barrier invalidation has priority over a possible limit fill\nwhenever intrabar ordering cannot be established from OHLC.\n\nSymmetric LONG/SHORT.\n\nNo tick-path reconstruction.\n\nNo future candle may resolve prior ambiguity."
    },
    {
      "section": 7,
      "title": "EXACT-LEVEL OPEN CASES",
      "text": "Freeze boundary semantics explicitly.\n\nBarrier equality invalidates BEFORE fill:\n\nLONG:\nOpen == S -> INVALIDATED_UNFILLED\nOpen == T -> INVALIDATED_UNFILLED\n\nSHORT:\nOpen == S -> INVALIDATED_UNFILLED\nOpen == T -> INVALIDATED_UNFILLED\n\nLimit equality inside barriers fills:\n\nLONG:\nOpen == EL -> fill at EL -> ACTIVE\n\nSHORT:\nOpen == EL -> fill at EL -> ACTIVE\n\nThus ordering at OPEN is:\n\n1. terminal barrier invalidation\n2. marketable limit fill\n3. remaining intrabar processing"
    },
    {
      "section": 8,
      "title": "ALREADY ACTIVE DISTINCTION",
      "text": "These pre-fill rules apply ONLY to WAITING_ENTRY.\n\nFor a position proven ACTIVE in an earlier candle:\n\nexisting protocol rules remain:\n\n- adverse opening gap through Stop -> exit at observed adverse Open\n- Target favorable gap -> frozen Target\n- Stop + Target same candle unknown order -> STOP\n- Stop -> STOP\n- Target -> TP\n- horizon -> TIME_EXIT.\n\nDo NOT convert ACTIVE positions back into pre-fill invalidation."
    },
    {
      "section": 9,
      "title": "EXPIRY INTERACTION",
      "text": "A candle may establish a fill only if it is fully eligible under the\nfrozen expiry rule.\n\nA candle crossing the expiry boundary is excluded even if its Open\nwould otherwise make the limit marketable.\n\nAfter the last fully eligible entry candle:\n\nWAITING_ENTRY -> UNFILLED\n0R\n0 fees.\n\nDo not use a partial expiry candle."
    },
    {
      "section": 10,
      "title": "WHY THIS AMENDMENT EXISTS",
      "text": "Record both pre-outcome blockers:\n\nBLOCKER 1:\nWAITING_ENTRY candle containing EL together with Stop/Target without\nknown intrabar order.\n\nBLOCKER 2:\nWAITING_ENTRY candle opening through EL while remaining inside frozen\nbarriers.\n\nThe protocol previously did not define whether the second case was a\nfill or required later exact EL touch.\n\nRevision 2 freezes:\n\nmarketable-at-open -> fill,\nbut Entry price remains frozen EL,\nwith no favorable price improvement.\n\nAll decisions occurred BEFORE historical outcomes."
    }
  ],
  "designValidation": {
    "method": "reasoned synthetic state cases only, no engine execution",
    "directions": [
      "LONG",
      "SHORT"
    ],
    "cases": [
      "open beyond Stop",
      "open exactly Stop",
      "open beyond Target",
      "open exactly Target",
      "open through EL inside barriers",
      "open exactly EL",
      "nonmarketable open EL only",
      "S only",
      "T only",
      "EL+S",
      "EL+T",
      "EL+S+T",
      "expiry exclusion",
      "already ACTIVE",
      "open-fill then Stop",
      "open-fill then Target",
      "open-fill then both"
    ],
    "result": "PASS",
    "note": "S-only intrabar after nonmarketable inside-barrier open is unreachable for valid ordered OHLC without EL crossing; prescribed defensive classification retained",
    "anotherBlockerFound": false
  },
  "noImplementation": true
}
```

## Normative clarification

### 2. SCOPE OF AMENDMENT

Clarify ONLY Alternative WAITING_ENTRY execution semantics.

Do NOT change:

universe
calendar
observation time
P0
ATR
pullback 0.25A
Stop
Target
expiry
horizon
fees
primary metric
bootstrap
Development rule
Holdout rule.

### 3. WAITING_ENTRY OPEN-EVENT PRIORITY

For every eligible 1m candle while Alternative is WAITING_ENTRY:

PROCESS CANDLE OPEN FIRST.

Let:

LONG:
S < EL < T

SHORT:
T < EL < S

First determine whether Open itself proves that a frozen terminal
barrier has already been reached/crossed before a valid new fill.

Barrier invalidation has priority over opening limit fill.

Therefore:

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

Only if Open remains STRICTLY inside S/T may an opening limit fill be
considered.

### 4. MARKETABLE-AT-OPEN LIMIT

If state is WAITING_ENTRY and Open remains strictly inside frozen
barriers:

LONG buy-limit EL:

if Open <= EL:
    limit is considered FILLED at the OPEN event.

SHORT sell-limit EL:

if Open >= EL:
    limit is considered FILLED at the OPEN event.

IMPORTANT MODEL EXECUTION PRICE:

Entry = frozen EL

NOT candle Open.

There is NO favorable price improvement.

Examples:

LONG:
S=96
EL=99
T=104
Open=98

=> opening barrier invalidation: NO
=> marketable limit: YES
=> Entry=99
=> state ACTIVE before intrabar high/low processing.

SHORT:
T=96
EL=101
S=104
Open=102

=> opening barrier invalidation: NO
=> marketable limit: YES
=> Entry=101
=> state ACTIVE before intrabar high/low processing.

This is a deterministic research execution convention.
It is NOT a claim about exact historical exchange fill price.

### 5. AFTER OPEN-EVENT FILL

Once marketable-at-open fill is established:

state becomes ACTIVE immediately.

Then process the SAME candle's remaining intrabar high/low under
ACTIVE rules.

Therefore:

Stop only touched after open -> STOP
Target only -> TP
Stop + Target with unknown order -> STOP

Adverse Stop gap cannot occur later inside that same candle because
the candle Open has already been processed; ordinary Stop touch uses
frozen Stop.

No favorable Target improvement.

### 6. WAITING_ENTRY INTRABAR RULES

If Open:

- does not invalidate the setup; AND
- does not make the limit marketable;

then process intrabar ranges.

For unknown intrabar order:

EL only:
    fill at frozen EL -> ACTIVE

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

Pre-fill barrier invalidation has priority over a possible limit fill
whenever intrabar ordering cannot be established from OHLC.

Symmetric LONG/SHORT.

No tick-path reconstruction.

No future candle may resolve prior ambiguity.

### 7. EXACT-LEVEL OPEN CASES

Freeze boundary semantics explicitly.

Barrier equality invalidates BEFORE fill:

LONG:
Open == S -> INVALIDATED_UNFILLED
Open == T -> INVALIDATED_UNFILLED

SHORT:
Open == S -> INVALIDATED_UNFILLED
Open == T -> INVALIDATED_UNFILLED

Limit equality inside barriers fills:

LONG:
Open == EL -> fill at EL -> ACTIVE

SHORT:
Open == EL -> fill at EL -> ACTIVE

Thus ordering at OPEN is:

1. terminal barrier invalidation
2. marketable limit fill
3. remaining intrabar processing

### 8. ALREADY ACTIVE DISTINCTION

These pre-fill rules apply ONLY to WAITING_ENTRY.

For a position proven ACTIVE in an earlier candle:

existing protocol rules remain:

- adverse opening gap through Stop -> exit at observed adverse Open
- Target favorable gap -> frozen Target
- Stop + Target same candle unknown order -> STOP
- Stop -> STOP
- Target -> TP
- horizon -> TIME_EXIT.

Do NOT convert ACTIVE positions back into pre-fill invalidation.

### 9. EXPIRY INTERACTION

A candle may establish a fill only if it is fully eligible under the
frozen expiry rule.

A candle crossing the expiry boundary is excluded even if its Open
would otherwise make the limit marketable.

After the last fully eligible entry candle:

WAITING_ENTRY -> UNFILLED
0R
0 fees.

Do not use a partial expiry candle.

### 10. WHY THIS AMENDMENT EXISTS

Record both pre-outcome blockers:

BLOCKER 1:
WAITING_ENTRY candle containing EL together with Stop/Target without
known intrabar order.

BLOCKER 2:
WAITING_ENTRY candle opening through EL while remaining inside frozen
barriers.

The protocol previously did not define whether the second case was a
fill or required later exact EL touch.

Revision 2 freezes:

marketable-at-open -> fill,
but Entry price remains frozen EL,
with no favorable price improvement.

All decisions occurred BEFORE historical outcomes.

## Design validation

LONG and SHORT cases A–L reviewed without historical candles or execution. Open barrier equality invalidates first; inside-barrier limit equality fills; open-fill switches to ACTIVE for the same candle. Nonmarketable waiting intrabar barrier combinations invalidate; EL-only fills; no touch remains waiting. Partial expiry candles cannot fill. Already ACTIVE positions retain base gap and Stop-first rules. No further blocker found in this scope. Engine acceptance tests remain required in R7-C1.

HISTORICAL OUTCOMES INSPECTED: NO
DEVELOPMENT OPENED: NO
HOLDOUT OPENED: NO
CORE: FROZEN
REAL-MONEY: HOLD
R6: PAUSED
FORWARD: PAUSED
