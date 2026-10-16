# Market Entry Mechanics Research v1.0

Protocol: `market-entry-mechanics-v1.0`

Status: preregistered on commit; no outcome execution authorized by this documentation task.

Holdout cleanliness: **PENDING PRE-RUN AUDIT**, not verified by this document.

Methodology decision: deterministic conservative OHLC convention replaces the earlier bounded-uncertainty proposal. Independent adverse conventions do not prove a conservative bound on the paired effect or reproduce actual tick execution.

## Frozen machine-readable parameters

The following block exactly reproduces the companion JSON. Its normativeSections are the complete approved substantive specification. No historical performance values are included.

```json
{
  "protocolVersion": "market-entry-mechanics-v1.0",
  "scope": "Generic entry mechanics; not SM1M signal validation, portfolio P&L or real-money authorization",
  "status": {
    "preregistration": "FROZEN_ON_COMMIT",
    "historicalOutcomesInspected": false,
    "developmentOpened": false,
    "holdoutOpened": false,
    "holdoutCleanliness": "PENDING_PRE_RUN_AUDIT",
    "executionTable": "REQUIRED_IN_R7_C_BEFORE_OUTCOMES",
    "core": "FROZEN",
    "realMoney": "HOLD",
    "r6": "PAUSED",
    "forward": "PAUSED"
  },
  "universe": {
    "instruments": [
      "BTC-USDT-SWAP",
      "ETH-USDT-SWAP",
      "SOL-USDT-SWAP"
    ],
    "venue": "OKX",
    "source": "public historical market candles",
    "type": "USDT perpetual SWAP",
    "survivorUniverse": true,
    "replacementAllowed": false,
    "eligibilityFailure": "STOP_BEFORE_OUTCOMES"
  },
  "calendar": {
    "timezone": "UTC",
    "observationTime": "17:00:00",
    "development": {
      "start": "2024-11-01",
      "end": "2025-10-31",
      "inclusive": true
    },
    "embargo": {
      "start": "2025-11-01",
      "end": "2025-11-01",
      "observations": false
    },
    "holdout": {
      "start": "2025-11-02",
      "end": "2026-04-30",
      "inclusive": true
    }
  },
  "episode": {
    "identity": [
      "instrument",
      "observationAt"
    ],
    "directions": {
      "LONG": 1,
      "SHORT": -1
    },
    "dependentPair": true,
    "variantResult": "(longNetR + shortNetR) / 2"
  },
  "cutoff": {
    "setupAtOrBefore": "observationAt",
    "confirmedFullyClosedOnly": true,
    "futureUse": "execution/outcome evaluation only; never modify frozen setup"
  },
  "reference": {
    "name": "P0",
    "bar": "1m",
    "price": "close",
    "selection": "final fully closed confirmed candle with closeTime <= observationAt",
    "provenanceRequired": true,
    "missing": "DATA_UNAVAILABLE"
  },
  "atr": {
    "name": "A",
    "definition": "arithmetic mean(high-low)",
    "length": 14,
    "bar": "1D",
    "alignmentUTC": "16:00:00",
    "fullyClosedConfirmedOnly": true,
    "selection": "final 14 eligible candles at observationAt",
    "require": "finite A > 0",
    "wilder": false,
    "allow1Dutc": false
  },
  "baseline": {
    "entry": "open of first fully eligible confirmed 1m candle after observationAt",
    "name": "EB",
    "geometry": {
      "LONG": "S < EB < T",
      "SHORT": "T < EB < S"
    },
    "outsideGeometry": {
      "classification": "INVALIDATED_UNFILLED",
      "resultR": 0,
      "fees": 0
    }
  },
  "alternative": {
    "candidateCount": 1,
    "family": "fixed pullback limit",
    "entry": "EL = P0 - d * 0.25 * A",
    "pullbackATR": 0.25,
    "normalRiskATR": 0.75,
    "rewardDistanceATR": 1.25,
    "gridAllowed": false
  },
  "barriers": {
    "stop": "S = P0 - d * A",
    "target": "T = P0 + d * A",
    "stopATR": 1,
    "targetATR": 1,
    "sharedAbsoluteLevels": true,
    "moveAfterEntry": false
  },
  "expiry": {
    "hours": 4,
    "from": "observationAt",
    "appliesTo": "alternative entry",
    "partialCrossingCandleEligible": false,
    "noFill": "UNFILLED"
  },
  "horizon": {
    "hours": 12,
    "from": "observationAt",
    "commonAcrossVariants": true,
    "openPosition": "TIME_EXIT",
    "exitPrice": "close of final eligible confirmed 1m candle with closeTime <= horizon",
    "missingRequiredFinalCandle": "DATA_UNAVAILABLE"
  },
  "r": {
    "initialRisk": "abs(Entry - Stop)",
    "require": "finite initialRisk > 0",
    "gross": "d * (exitPrice - Entry) / initialRisk",
    "leverageMultiplier": false
  },
  "fees": {
    "ratePerExecutedSide": 0.0005,
    "entryFee": "Entry * f for unit position",
    "exitFee": "exitPrice * f for unit position",
    "feeR": "(entryFee + exitFee) / initialRisk",
    "netR": "modelGrossR - feeR",
    "unfilledFee": 0,
    "invalidatedUnfilledFee": 0,
    "actualAccountFeeClaim": false,
    "separateSlippageModel": false
  },
  "resultClasses": {
    "numeric": [
      "TP",
      "STOP",
      "TIME_EXIT",
      "UNFILLED",
      "INVALIDATED_UNFILLED"
    ],
    "zero": [
      "UNFILLED",
      "INVALIDATED_UNFILLED"
    ],
    "nonTradingFailure": [
      "DATA_UNAVAILABLE",
      "INTEGRITY_FAILURE",
      "SPECIFICATION_FAILURE"
    ],
    "postHocAmbiguousExclusionAllowed": false
  },
  "execution": {
    "policy": "deterministic conservative OHLC convention",
    "openEventsFirst": true,
    "alreadyOpenUnorderedBothBarriers": "STOP",
    "adverseStopGap": "observed adverse OPEN, no -1R cap",
    "target": "frozen Target; no favorable gap improvement",
    "sameCandleFillBarrierInvalidation": "adverse consistent branch; finite explicit state/event table required before outcomes",
    "tickPathReconstruction": false,
    "futureRetroactiveOrdering": false,
    "prefillInvalidation": "INVALIDATED_UNFILLED if established before fill",
    "unresolvedSubstantiveAssumption": "STOP_BEFORE_OUTCOMES_AND_TRANSPARENT_AMENDMENT",
    "priorBoundedInferenceAdopted": false
  },
  "dataRecovery": {
    "phase": "before outcome analysis",
    "maxRefetchAttempts": 2,
    "deterministicSameRuleAllWindows": true,
    "provenance": true,
    "outcomeBasedVersionSelection": false,
    "unresolvedRequiredData": "INVALID / NOT INTERPRETABLE",
    "dropEpisode": false,
    "zeroImputation": false,
    "replaceInstrument": false,
    "changeDates": false
  },
  "identityControl": {
    "baselineIdentical": true,
    "equal": [
      "classification",
      "Entry",
      "Exit",
      "Gross R",
      "Net R"
    ],
    "delta": 0,
    "sharedIntegrityFailureException": true,
    "strategyCandidate": false
  },
  "primary": {
    "effect": "mean(alternativeEpisodeNetR - baselineEpisodeNetR)",
    "population": "all scheduled valid episodes in analysis block; unresolved required primary failures invalidate analysis",
    "unfilledIncluded": true,
    "invalidatedIncluded": true,
    "filledOnly": false
  },
  "secondary": [
    "fill count/rate",
    "TP count/rate",
    "STOP count/rate",
    "TIME_EXIT count/rate",
    "UNFILLED count/rate",
    "INVALIDATED_UNFILLED count/rate",
    "median episode Net R",
    "descriptive LONG results",
    "descriptive SHORT results",
    "coverage/integrity counts"
  ],
  "bootstrap": {
    "method": "moving-block",
    "unit": "UTC observation day with all instruments/directions/variants",
    "blockDays": 7,
    "repetitions": 10000,
    "seed": 20261016,
    "interval": "percentile",
    "quantiles": [
      0.025,
      0.975
    ],
    "quantileType": 7,
    "withReplacement": true,
    "truncateFinalBlock": true,
    "resampleLength": "original number of observation days",
    "separateBlocks": [
      "development",
      "holdout"
    ],
    "coverageClaim": "nominal; not exact finite-sample 95%"
  },
  "developmentRule": {
    "allRequired": [
      "protocol/config/data integrity PASS",
      "identity/synthetic tests PASS",
      "no unresolved required primary data/integrity failure",
      "mean(deltaEpisode) > 0",
      "lower 2.5% bootstrap bound > 0"
    ],
    "pass": "ADVANCE TO HOLDOUT",
    "failure": "NO CANDIDATE ADVANCES",
    "integrityFailure": "INVALID / NOT INTERPRETABLE",
    "validCriterionFailure": "NO EVIDENCE OF IMPROVEMENT",
    "holdoutOnFailure": false
  },
  "holdoutRule": {
    "confirmed": "all integrity gates PASS AND mean > 0 AND lower 2.5% bound > 0",
    "notConfirmed": "valid AND (mean <= 0 OR upper 97.5% bound < 0)",
    "inconclusive": "valid AND mean > 0 AND interval includes/touches 0",
    "invalid": [
      "sealing failure",
      "unresolved required data failure",
      "execution specification failure",
      "protocol/config/hash mismatch",
      "other frozen integrity gate failure"
    ],
    "reopenAfterModelChange": false
  },
  "holdoutCleanliness": {
    "auditBefore": "any development outcome execution",
    "check": "prior evaluation of exact generic daily holdout episodes",
    "priorSM1M91Research": "disclosed development knowledge, not automatically identical sampling experiment",
    "contamination": "STOP; no silent replacement holdout",
    "currentVerification": "NOT YET AUDITED"
  },
  "dataset": {
    "method": "sparse/windowed",
    "inputs": [
      "reference 1m",
      "execution 1m through +12h",
      "last 14 fully closed 1D",
      "technical metadata"
    ],
    "mergeOverlaps": true,
    "dedupKey": [
      "instrument",
      "bar",
      "openTime"
    ],
    "preserve": [
      "raw values",
      "confirm",
      "request/data provenance"
    ],
    "manifestHashes": true,
    "requires1H": false
  },
  "sealing": {
    "beforeDevelopment": [
      "protocol hash",
      "config hash",
      "code commit/hash",
      "universe",
      "calendar",
      "observation schedule",
      "dataset manifest/hash",
      "episode IDs",
      "execution-policy version",
      "fee convention",
      "bootstrap config",
      "selection rule"
    ],
    "beforeHoldout": [
      "holdout dataset identity",
      "no prior outcome report",
      "development advancement record"
    ]
  },
  "prohibitions": [
    "pullback grid",
    "ATR grid",
    "Stop grid",
    "Target grid",
    "expiry search",
    "horizon search",
    "observation time search",
    "instrument subset search",
    "fee search",
    "bootstrap block search",
    "subgroup candidate selection",
    "Long-only/Short-only primary",
    "secondary overriding primary",
    "MFE/MAE in v1.0",
    "old 91-signal random control as evidence",
    "repeated holdout tuning"
  ],
  "amendment": {
    "afterOutcomeInspection": "new protocol version, explicit history and untouched validation dataset/holdout where required",
    "unknownExecutionState": "stop before outcomes if new substantive assumption needed"
  },
  "normativeSections": [
    {
      "section": 1,
      "title": "PURPOSE",
      "text": "This experiment tests ONE question:\n\nDoes waiting for a fixed ATR-normalized pullback improve generic\nentry mechanics relative to immediate market entry, when both variants\nshare the same frozen market Stop and Target?\n\nThis is NOT:\n\n- SM1M validation;\n- A+ validation;\n- Opportunity Score validation;\n- component validation;\n- a test of SM1M profitability;\n- permission to modify Core;\n- permission for real-money trading."
    },
    {
      "section": 2,
      "title": "RESEARCH VERSION",
      "text": "Protocol name:\n\nmarket-entry-mechanics-v1.0\n\nOnce committed, all substantive parameters below are frozen before\nDevelopment outcomes are inspected.\n\nAny substantive change after outcome inspection requires:\n\n- a new protocol version;\n- explicit amendment history;\n- a new untouched validation dataset/holdout where required.\n\nThe existing Holdout must never be repeatedly reopened for tuning."
    },
    {
      "section": 3,
      "title": "UNIVERSE",
      "text": "Fixed universe:\n\nBTC-USDT-SWAP\nETH-USDT-SWAP\nSOL-USDT-SWAP\n\nVenue/source:\nOKX public historical market candles.\n\nDo NOT add or replace an instrument after observing performance.\n\nBefore outcome analysis each instrument must pass technical\neligibility:\n\n- instrument existed sufficiently before Development start;\n- required 1m and 1D data are available;\n- timestamps and candle schema are valid.\n\nIf an instrument fails technical eligibility:\n\nDO NOT substitute another instrument.\n\nStop and report protocol feasibility/integrity issue before outcomes.\n\nExplicit limitation:\n\nThis is a fixed survivor-instrument experiment.\nIt does NOT estimate performance across the complete historical OKX\nperpetual universe."
    },
    {
      "section": 4,
      "title": "CALENDAR",
      "text": "Observation time:\n\n17:00:00 UTC daily.\n\nDevelopment observation dates:\n\n2024-11-01 through 2025-10-31 inclusive.\n\nEmbargo:\n\n2025-11-01\nNO observations.\n\nSealed Holdout observation dates:\n\n2025-11-02 through 2026-04-30 inclusive.\n\nHoldout MUST NOT be analyzed unless the candidate passes the frozen\nDevelopment advancement rule.\n\nThe Holdout is considered untouched for this GENERIC DAILY EPISODE\nexperiment unless a pre-run audit proves that these exact generic\nepisode outcomes have previously been inspected.\n\nPrevious SM1M 91-signal research does not automatically count as this\ngeneric daily sampling experiment, but disclose it as prior\ndevelopment knowledge."
    },
    {
      "section": 5,
      "title": "UNIT OF OBSERVATION",
      "text": "One market episode:\n\ninstrument × observationAt\n\nAt every episode evaluate BOTH:\n\nLONG\nSHORT\n\nThey are a dependent pair.\n\nThey are NOT counted as two independent market observations.\n\nFor each variant:\n\nepisodeNetR =\n(longNetR + shortNetR) / 2\n\nPrimary comparison:\n\ndeltaEpisode =\nalternativeEpisodeNetR - baselineEpisodeNetR\n\nInterpretation:\n\nThis estimates the average effect of changing Entry mechanics under\nsymmetric absence of a directional prediction.\n\nIt is NOT portfolio P&L and NOT a claim that LONG and SHORT would\nactually be traded simultaneously."
    },
    {
      "section": 6,
      "title": "MARKET DATA CUTOFF",
      "text": "Only information available at or before observationAt may define the\nsetup.\n\nFuture candles may be used ONLY for execution/outcome evaluation after\nthe setup is frozen.\n\nAll setup inputs must be derived from confirmed, fully closed candles.\n\nNo future candle may modify:\n\nP0\nATR\nEntry\nStop\nTarget\nexpiry\nhorizon."
    },
    {
      "section": 7,
      "title": "REFERENCE PRICE",
      "text": "P0:\n\nclose of the final fully closed confirmed 1m candle whose closeTime is\n<= observationAt.\n\nThe implementation must freeze exact timestamp and price provenance.\n\nMissing/invalid reference candle:\n\nDATA_UNAVAILABLE / integrity failure.\n\nDo not substitute a later candle."
    },
    {
      "section": 8,
      "title": "ATR",
      "text": "Define A as:\n\narithmetic mean(high - low)\n\nof the final 14 fully closed confirmed OKX `1D` candles available at\nobservationAt.\n\nUse the demonstrated OKX 1D alignment:\n\n16:00 UTC.\n\nThis is:\n\nCore-style range ATR14\n\nNOT Wilder ATR.\n\nFormula:\n\nA = mean(high_i - low_i), i = last 14 eligible 1D candles.\n\nRequire:\n\nfinite A > 0.\n\nOtherwise integrity failure.\n\nDo NOT use `1Dutc`."
    },
    {
      "section": 9,
      "title": "DIRECTION",
      "text": "d = +1 LONG\nd = -1 SHORT\n\nEvery geometry rule must be mirror-symmetric by d.\n\nNo directional SM1M signal is used."
    },
    {
      "section": 10,
      "title": "FROZEN COMMON MARKET BARRIERS",
      "text": "For each direction:\n\nStop:\nS = P0 - d × A\n\nTarget:\nT = P0 + d × A\n\nThese absolute market levels are shared by Baseline and Alternative.\n\nThey do NOT move after actual Entry is known.\n\nPurpose:\n\nisolate Entry mechanics as far as practical while keeping common\nmarket barriers."
    },
    {
      "section": 11,
      "title": "BASELINE",
      "text": "Baseline = immediate model market entry.\n\nEntry execution:\n\nopen of the first fully eligible confirmed 1m candle after\nobservationAt.\n\nCall actual baseline entry:\n\nEB.\n\nBefore opening the position require directional geometry:\n\nLONG:\nS < EB < T\n\nSHORT:\nT < EB < S\n\nIf EB is NOT strictly between frozen Stop and Target:\n\nclassification =\nINVALIDATED_UNFILLED\n\nresult =\n0R\n\nfees =\n0\n\nDo NOT move Stop/Target.\nDo NOT fabricate an Entry at P0.\nDo NOT classify this as a trading loss."
    },
    {
      "section": 12,
      "title": "ALTERNATIVE",
      "text": "Single alternative only:\n\nfixed pullback limit.\n\nFrozen limit:\n\nEL = P0 - d × 0.25A\n\nNo other pullback distance exists in v1.0.\n\nDo NOT test:\n\n0.10A\n0.15A\n0.20A\n0.30A\n0.50A\nor any grid.\n\nAlternative initial risk if filled normally:\n\nabs(EL - S) = 0.75A\n\nPotential reward to common Target:\n\nabs(T - EL) = 1.25A\n\nThese are geometry facts, not performance claims."
    },
    {
      "section": 13,
      "title": "ENTRY EXPIRY",
      "text": "Alternative entry expiry:\n\nobservationAt + 4 hours.\n\nOnly fully closed 1m candles satisfying the frozen eligibility rules\nmay establish fill.\n\nA partial candle crossing the expiry boundary is NOT eligible.\n\nIf no valid fill occurs:\n\nUNFILLED\n0R\nfees = 0."
    },
    {
      "section": 14,
      "title": "OUTCOME HORIZON",
      "text": "Common horizon:\n\nobservationAt + 12 hours.\n\nNOT:\n\nfillAt + 12h.\n\nThe horizon is identical for Baseline and Alternative.\n\nIf an opened position has reached neither Stop nor Target by horizon:\n\nTIME_EXIT\n\nat the close of the final fully eligible confirmed 1m candle with:\n\ncloseTime <= horizon.\n\nIf required final candle is unavailable:\n\nDATA_UNAVAILABLE.\n\nDo not invent an exit."
    },
    {
      "section": 15,
      "title": "MODEL R",
      "text": "For an executed position:\n\ninitialRisk =\nabs(Entry - Stop)\n\nRequire:\n\nfinite initialRisk > 0.\n\nGross R:\n\nLONG:\n(exitPrice - Entry) / initialRisk\n\nSHORT:\n(Entry - exitPrice) / initialRisk\n\nEquivalent:\n\nd × (exitPrice - Entry) / initialRisk.\n\nNo leverage multiplication."
    },
    {
      "section": 16,
      "title": "FEES",
      "text": "Research fee convention:\n\nf = 0.0005\n\nper executed side.\n\nThis is a deterministic conservative research convention, NOT a claim\nabout actual account fee tier.\n\nFor unit position:\n\nentryFee = Entry × f\nexitFee = exitPrice × f\n\ntotalFee = entryFee + exitFee\n\nfeeR = totalFee / initialRisk\n\nmodelNetR = modelGrossR - feeR\n\nUNFILLED and INVALIDATED_UNFILLED:\n\nfees = 0.\n\nNo separate slippage model in v1.0.\n\nExplicit limitation:\nfee convention + adverse gap handling do NOT fully model live\nexecution/slippage."
    },
    {
      "section": 17,
      "title": "CONSERVATIVE OHLC EXECUTION POLICY",
      "text": "Critical principle:\n\nKnown OHLC + unknown intraminute path is NOT DATA_UNAVAILABLE.\n\nv1.0 uses one deterministic conservative execution convention.\n\nIt must NEVER select a favorable unknown ordering for a variant.\n\nBefore any Development outcome is inspected, the implementation phase\nmust encode and synthetic-test a COMPLETE event-priority table.\n\nThe preregistration must explicitly freeze the following principles:\n\nA. Events provable at candle OPEN are processed before intrabar\nhigh/low touches.\n\nB. Already-open position:\n\nIf Stop and Target are both touched in the same eligible 1m candle and\nOHLC cannot establish a unique ordering:\n\nSTOP wins.\n\nC. Known adverse opening gap through Stop for an already-open position:\n\nexecute at observed adverse candle OPEN.\n\nDo not cap at -1R.\n\nD. No favorable gap improvement at Target:\n\nTarget exit is at frozen Target unless an already frozen explicit\nrule says otherwise.\n\nE. Alternative limit fill:\n\nDo NOT assume favorable fill/order when the same candle contains\nevents whose ordering cannot be determined from OHLC.\n\nFor any same-candle sequence involving:\n\nlimit fill\nStop\nTarget\nsetup invalidation\n\nchoose the deterministic branch that is adverse to the evaluated\nvariant among the branches consistent with the candle and frozen\nstate.\n\nHowever, this phrase MUST NOT remain the only implementation\nspecification.\n\nR7-C implementation MUST create a finite explicit state/event priority\ntable covering every reachable combination BEFORE historical outcome\nexecution.\n\nThat table must be frozen and synthetic-tested before Development is\nopened.\n\nF. No tick-path reconstruction.\n\nG. Future candles may not be used to retroactively choose the ordering\nof an earlier ambiguous candle."
    },
    {
      "section": 18,
      "title": "PRE-FILL INVALIDATION",
      "text": "For the Alternative, the setup may become invalid before a proven\nlimit fill.\n\nThe implementation must define this deterministically from the common\nfrozen barriers and candle event priority.\n\nIf setup invalidation is established before fill:\n\nINVALIDATED_UNFILLED\n0R\nfees = 0.\n\nIf fill and invalidating event coexist in a candle with unknowable\norder:\n\nuse the frozen conservative event-priority policy.\n\nDo NOT choose the branch that improves Alternative performance."
    },
    {
      "section": 19,
      "title": "FINAL RESULT CLASSES",
      "text": "Normal numeric research outcomes:\n\nTP\nSTOP\nTIME_EXIT\nUNFILLED\nINVALIDATED_UNFILLED\n\nUNFILLED:\n0R.\n\nINVALIDATED_UNFILLED:\n0R.\n\nMarket-path ambiguity is resolved by the frozen deterministic\nconservative execution convention and therefore must NOT silently\nproduce a post-hoc AMBIGUOUS exclusion.\n\nSeparate non-trading failures:\n\nDATA_UNAVAILABLE\nINTEGRITY_FAILURE\nSPECIFICATION_FAILURE\n\nThese are NOT assigned 0R."
    },
    {
      "section": 20,
      "title": "TRUE DATA UNAVAILABILITY",
      "text": "Examples:\n\nmissing required 1m candle\ninvalid/corrupt OHLC\nconflicting duplicate\nrequired confirm != 1\nmissing reference candle\nmissing ATR context\nmissing horizon close\ninvalid timestamps.\n\nBefore outcome analysis:\n\nperform dataset completeness/integrity validation.\n\nFor a technically missing/corrupt public-data window:\n\nmaximum TWO deterministic re-fetch attempts.\n\nSame rule for all windows.\n\nRecord provenance.\n\nDo NOT select between conflicting data versions according to strategy\noutcome.\n\nIf required data remain unavailable after the frozen recovery process:\n\nprimary confirmatory analysis is:\n\nINVALID / NOT INTERPRETABLE.\n\nDo NOT:\n\ndrop the episode\nreplace with 0\nreplace instrument\nchange dates."
    },
    {
      "section": 21,
      "title": "IDENTITY CONTROL",
      "text": "Implementation must include an identity-control variant whose geometry,\nexecution and fees are exactly identical to Baseline.\n\nFor every episode:\n\nclassification identical\nEntry identical\nExit identical\nGross R identical\nNet R identical\n\nand:\n\nidentityDelta = exactly 0\n\nsubject only to shared integrity/data failure.\n\nIdentity control is an implementation test.\n\nIt is NOT a strategy candidate."
    },
    {
      "section": 22,
      "title": "PRIMARY METRIC",
      "text": "For each valid episode:\n\nbaselineEpisodeNetR =\n(baselineLongNetR + baselineShortNetR) / 2\n\nalternativeEpisodeNetR =\n(alternativeLongNetR + alternativeShortNetR) / 2\n\ndeltaEpisode =\nalternativeEpisodeNetR - baselineEpisodeNetR\n\nPrimary effect:\n\nmean(deltaEpisode)\n\nacross all scheduled valid episodes in the corresponding analysis\nblock.\n\nUNFILLED and INVALIDATED_UNFILLED remain numeric 0R and remain in the\ndenominator.\n\nDo NOT perform filled-only primary analysis."
    },
    {
      "section": 23,
      "title": "SECONDARY DIAGNOSTICS",
      "text": "Pre-register only:\n\n- fill count/rate\n- TP count/rate\n- STOP count/rate\n- TIME_EXIT count/rate\n- UNFILLED count/rate\n- INVALIDATED_UNFILLED count/rate\n- median episode Net R\n- descriptive LONG results\n- descriptive SHORT results\n- coverage/integrity counts\n\nSecondary diagnostics:\n\ndo NOT select candidate\ndo NOT override failed primary criterion\ndo NOT justify parameter changes inside v1.0.\n\nNo MFE/MAE in v1.0."
    },
    {
      "section": 24,
      "title": "DEPENDENCE / BOOTSTRAP",
      "text": "Use:\n\n7-day moving-block bootstrap of UTC observation days.\n\nEach sampled day carries ALL:\n\ninstruments\ndirections\nvariants\n\ntogether.\n\nDevelopment and Holdout are analyzed separately.\n\nParameters:\n\n10,000 bootstrap repetitions\nseed = 20261016\npercentile interval\n2.5% / 97.5%\nType-7 quantiles.\n\nBlocks are sampled with replacement until original number of\nobservation days is reached; final block is truncated as needed.\n\nThis produces a nominal block-bootstrap uncertainty interval.\n\nDo NOT claim exact finite-sample 95% coverage."
    },
    {
      "section": 25,
      "title": "DEVELOPMENT ADVANCEMENT RULE",
      "text": "There is exactly ONE candidate Alternative.\n\nIt advances to sealed Holdout ONLY if:\n\n1. Protocol/config/data integrity PASS.\n2. Identity/synthetic execution tests PASS.\n3. No unresolved DATA_UNAVAILABLE / integrity failure affecting\n   primary population.\n4. mean(deltaEpisode) > 0.\n5. lower 2.5% bound of the frozen Development block-bootstrap\n   interval > 0.\n\nIf all five pass:\n\nADVANCE TO HOLDOUT.\n\nOtherwise:\n\nNO CANDIDATE ADVANCES.\n\nIf failure is methodological/data integrity:\n\nINVALID / NOT INTERPRETABLE.\n\nIf valid data but criterion 4/5 fails:\n\nNO EVIDENCE OF IMPROVEMENT.\n\nDo NOT create another pullback parameter from Development results\ninside v1.0.\n\nDo NOT inspect Holdout if candidate does not advance."
    },
    {
      "section": 26,
      "title": "SEALED HOLDOUT RULE",
      "text": "Holdout remains sealed until Development advancement is formally\nrecorded.\n\nAfter opening Holdout, no parameters may change.\n\nStatuses:\n\nCONFIRMED IMPROVEMENT:\n- all integrity gates PASS\n- mean(deltaEpisode) > 0\n- lower 2.5% Holdout bootstrap bound > 0\n\nNOT CONFIRMED:\n- valid analysis\n- mean(deltaEpisode) <= 0\n\nOR\n- upper 97.5% Holdout bootstrap bound < 0\n\nINCONCLUSIVE:\n- valid analysis\n- mean(deltaEpisode) > 0\n- interval includes/touches 0\n\nINVALID / NOT INTERPRETABLE:\n- sealing failure\n- unresolved required data failure\n- execution specification failure\n- protocol/config/hash mismatch\n- other frozen integrity gate failure.\n\nNo second Holdout inspection after changing the model."
    },
    {
      "section": 27,
      "title": "HOLDOUT CLEANLINESS",
      "text": "Before any Development outcome execution, document whether exact\ngeneric daily episodes for the proposed Holdout have previously been\nevaluated.\n\nPrevious research using 91 SM1M-selected signals is prior knowledge\nbut is not the same sampling experiment.\n\nIf exact generic Holdout outcomes were previously inspected:\n\nSTOP.\n\nDo not silently select a new Holdout.\n\nReport contamination and require protocol redesign before outcomes."
    },
    {
      "section": 28,
      "title": "DATASET DESIGN",
      "text": "Use sparse/windowed historical collection.\n\nDo NOT blindly download all continuous 1m history.\n\nFor each episode collect/cache only required:\n\n- reference 1m context\n- post-observation 1m execution/outcome window through +12h\n- last 14 fully closed 1D candles\n- necessary technical metadata.\n\nMerge overlapping requests.\nDeduplicate by instrument/bar/openTime.\nPreserve raw source values.\nPreserve confirm field.\nPreserve request/data provenance.\nGenerate deterministic dataset manifest and hashes.\n\n1H data are NOT required for v1.0."
    },
    {
      "section": 29,
      "title": "DATASET SEALING",
      "text": "Before Development outcome execution freeze:\n\nprotocol hash\nconfig hash\ncode commit/hash\nuniverse\ncalendar\nobservation schedule\ndataset manifest/hash\nepisode IDs\nexecution-policy version\nfee convention\nbootstrap config\nselection rule.\n\nBefore Holdout opening additionally verify:\n\nHoldout dataset identity\nno prior outcome report\nDevelopment advancement record."
    },
    {
      "section": 30,
      "title": "PARAMETER SEARCH PROHIBITED",
      "text": "Within v1.0 DO NOT search:\n\npullback distance\nATR length\nStop distance\nTarget distance\nexpiry\nhorizon\nobservation time\ninstrument subset\nfee\nbootstrap block length\ncandidate based on subgroup\nLong-only / Short-only primary result.\n\nNo:\n\n0.15A after 0.25A fails\n6h after 4h fails\n2A TP after 1A fails\ndifferent UTC hour\nremoving SOL because result is poor\netc.\n\nAny such research requires a NEW development protocol and untouched\nvalidation data."
    },
    {
      "section": 31,
      "title": "RANDOM CONTROL",
      "text": "Do NOT reuse the old 91-signal random control as evidence.\n\nFor v1.0, the mandatory null implementation control is the exact\nIDENTITY CONTROL.\n\nNo additional random-timestamp strategy control is required for the\nprimary question because sampling timestamps are already fixed\nindependently of strategy outcomes.\n\nIf future research adds a random control, it is a separate\npre-registered diagnostic and cannot retroactively alter v1.0."
    },
    {
      "section": 33,
      "title": "IMPORTANT EXECUTION-TABLE STATUS",
      "text": "R7-B2 freezes the PRINCIPLES of conservative execution.\n\nBut historical outcomes MUST NOT run until R7-C creates:\n\n- explicit finite event/state priority table;\n- generic plan builder;\n- simulator adapter;\n- synthetic tests.\n\nIf implementation reveals an execution state not resolvable under\nthis protocol WITHOUT adding a new substantive assumption:\n\nSTOP BEFORE OUTCOMES.\n\nAmend protocol transparently before Development is opened.\n\nDo NOT silently decide after seeing a historical result."
    }
  ],
  "pendingImplementationSpecifications": [
    "finite complete execution event/state priority table",
    "exact first eligible minute convention",
    "prefill invalidation event priorities",
    "deterministic PRNG algorithm and bootstrap block indexing",
    "technical eligibility checks including sufficiently early listing",
    "secondary diagnostic denominator definitions"
  ]
}
```

## Normative protocol

### 1. PURPOSE

This experiment tests ONE question:

Does waiting for a fixed ATR-normalized pullback improve generic
entry mechanics relative to immediate market entry, when both variants
share the same frozen market Stop and Target?

This is NOT:

- SM1M validation;
- A+ validation;
- Opportunity Score validation;
- component validation;
- a test of SM1M profitability;
- permission to modify Core;
- permission for real-money trading.

### 2. RESEARCH VERSION

Protocol name:

market-entry-mechanics-v1.0

Once committed, all substantive parameters below are frozen before
Development outcomes are inspected.

Any substantive change after outcome inspection requires:

- a new protocol version;
- explicit amendment history;
- a new untouched validation dataset/holdout where required.

The existing Holdout must never be repeatedly reopened for tuning.

### 3. UNIVERSE

Fixed universe:

BTC-USDT-SWAP
ETH-USDT-SWAP
SOL-USDT-SWAP

Venue/source:
OKX public historical market candles.

Do NOT add or replace an instrument after observing performance.

Before outcome analysis each instrument must pass technical
eligibility:

- instrument existed sufficiently before Development start;
- required 1m and 1D data are available;
- timestamps and candle schema are valid.

If an instrument fails technical eligibility:

DO NOT substitute another instrument.

Stop and report protocol feasibility/integrity issue before outcomes.

Explicit limitation:

This is a fixed survivor-instrument experiment.
It does NOT estimate performance across the complete historical OKX
perpetual universe.

### 4. CALENDAR

Observation time:

17:00:00 UTC daily.

Development observation dates:

2024-11-01 through 2025-10-31 inclusive.

Embargo:

2025-11-01
NO observations.

Sealed Holdout observation dates:

2025-11-02 through 2026-04-30 inclusive.

Holdout MUST NOT be analyzed unless the candidate passes the frozen
Development advancement rule.

The Holdout is considered untouched for this GENERIC DAILY EPISODE
experiment unless a pre-run audit proves that these exact generic
episode outcomes have previously been inspected.

Previous SM1M 91-signal research does not automatically count as this
generic daily sampling experiment, but disclose it as prior
development knowledge.

### 5. UNIT OF OBSERVATION

One market episode:

instrument × observationAt

At every episode evaluate BOTH:

LONG
SHORT

They are a dependent pair.

They are NOT counted as two independent market observations.

For each variant:

episodeNetR =
(longNetR + shortNetR) / 2

Primary comparison:

deltaEpisode =
alternativeEpisodeNetR - baselineEpisodeNetR

Interpretation:

This estimates the average effect of changing Entry mechanics under
symmetric absence of a directional prediction.

It is NOT portfolio P&L and NOT a claim that LONG and SHORT would
actually be traded simultaneously.

### 6. MARKET DATA CUTOFF

Only information available at or before observationAt may define the
setup.

Future candles may be used ONLY for execution/outcome evaluation after
the setup is frozen.

All setup inputs must be derived from confirmed, fully closed candles.

No future candle may modify:

P0
ATR
Entry
Stop
Target
expiry
horizon.

### 7. REFERENCE PRICE

P0:

close of the final fully closed confirmed 1m candle whose closeTime is
<= observationAt.

The implementation must freeze exact timestamp and price provenance.

Missing/invalid reference candle:

DATA_UNAVAILABLE / integrity failure.

Do not substitute a later candle.

### 8. ATR

Define A as:

arithmetic mean(high - low)

of the final 14 fully closed confirmed OKX `1D` candles available at
observationAt.

Use the demonstrated OKX 1D alignment:

16:00 UTC.

This is:

Core-style range ATR14

NOT Wilder ATR.

Formula:

A = mean(high_i - low_i), i = last 14 eligible 1D candles.

Require:

finite A > 0.

Otherwise integrity failure.

Do NOT use `1Dutc`.

### 9. DIRECTION

d = +1 LONG
d = -1 SHORT

Every geometry rule must be mirror-symmetric by d.

No directional SM1M signal is used.

### 10. FROZEN COMMON MARKET BARRIERS

For each direction:

Stop:
S = P0 - d × A

Target:
T = P0 + d × A

These absolute market levels are shared by Baseline and Alternative.

They do NOT move after actual Entry is known.

Purpose:

isolate Entry mechanics as far as practical while keeping common
market barriers.

### 11. BASELINE

Baseline = immediate model market entry.

Entry execution:

open of the first fully eligible confirmed 1m candle after
observationAt.

Call actual baseline entry:

EB.

Before opening the position require directional geometry:

LONG:
S < EB < T

SHORT:
T < EB < S

If EB is NOT strictly between frozen Stop and Target:

classification =
INVALIDATED_UNFILLED

result =
0R

fees =
0

Do NOT move Stop/Target.
Do NOT fabricate an Entry at P0.
Do NOT classify this as a trading loss.

### 12. ALTERNATIVE

Single alternative only:

fixed pullback limit.

Frozen limit:

EL = P0 - d × 0.25A

No other pullback distance exists in v1.0.

Do NOT test:

0.10A
0.15A
0.20A
0.30A
0.50A
or any grid.

Alternative initial risk if filled normally:

abs(EL - S) = 0.75A

Potential reward to common Target:

abs(T - EL) = 1.25A

These are geometry facts, not performance claims.

### 13. ENTRY EXPIRY

Alternative entry expiry:

observationAt + 4 hours.

Only fully closed 1m candles satisfying the frozen eligibility rules
may establish fill.

A partial candle crossing the expiry boundary is NOT eligible.

If no valid fill occurs:

UNFILLED
0R
fees = 0.

### 14. OUTCOME HORIZON

Common horizon:

observationAt + 12 hours.

NOT:

fillAt + 12h.

The horizon is identical for Baseline and Alternative.

If an opened position has reached neither Stop nor Target by horizon:

TIME_EXIT

at the close of the final fully eligible confirmed 1m candle with:

closeTime <= horizon.

If required final candle is unavailable:

DATA_UNAVAILABLE.

Do not invent an exit.

### 15. MODEL R

For an executed position:

initialRisk =
abs(Entry - Stop)

Require:

finite initialRisk > 0.

Gross R:

LONG:
(exitPrice - Entry) / initialRisk

SHORT:
(Entry - exitPrice) / initialRisk

Equivalent:

d × (exitPrice - Entry) / initialRisk.

No leverage multiplication.

### 16. FEES

Research fee convention:

f = 0.0005

per executed side.

This is a deterministic conservative research convention, NOT a claim
about actual account fee tier.

For unit position:

entryFee = Entry × f
exitFee = exitPrice × f

totalFee = entryFee + exitFee

feeR = totalFee / initialRisk

modelNetR = modelGrossR - feeR

UNFILLED and INVALIDATED_UNFILLED:

fees = 0.

No separate slippage model in v1.0.

Explicit limitation:
fee convention + adverse gap handling do NOT fully model live
execution/slippage.

### 17. CONSERVATIVE OHLC EXECUTION POLICY

Critical principle:

Known OHLC + unknown intraminute path is NOT DATA_UNAVAILABLE.

v1.0 uses one deterministic conservative execution convention.

It must NEVER select a favorable unknown ordering for a variant.

Before any Development outcome is inspected, the implementation phase
must encode and synthetic-test a COMPLETE event-priority table.

The preregistration must explicitly freeze the following principles:

A. Events provable at candle OPEN are processed before intrabar
high/low touches.

B. Already-open position:

If Stop and Target are both touched in the same eligible 1m candle and
OHLC cannot establish a unique ordering:

STOP wins.

C. Known adverse opening gap through Stop for an already-open position:

execute at observed adverse candle OPEN.

Do not cap at -1R.

D. No favorable gap improvement at Target:

Target exit is at frozen Target unless an already frozen explicit
rule says otherwise.

E. Alternative limit fill:

Do NOT assume favorable fill/order when the same candle contains
events whose ordering cannot be determined from OHLC.

For any same-candle sequence involving:

limit fill
Stop
Target
setup invalidation

choose the deterministic branch that is adverse to the evaluated
variant among the branches consistent with the candle and frozen
state.

However, this phrase MUST NOT remain the only implementation
specification.

R7-C implementation MUST create a finite explicit state/event priority
table covering every reachable combination BEFORE historical outcome
execution.

That table must be frozen and synthetic-tested before Development is
opened.

F. No tick-path reconstruction.

G. Future candles may not be used to retroactively choose the ordering
of an earlier ambiguous candle.

### 18. PRE-FILL INVALIDATION

For the Alternative, the setup may become invalid before a proven
limit fill.

The implementation must define this deterministically from the common
frozen barriers and candle event priority.

If setup invalidation is established before fill:

INVALIDATED_UNFILLED
0R
fees = 0.

If fill and invalidating event coexist in a candle with unknowable
order:

use the frozen conservative event-priority policy.

Do NOT choose the branch that improves Alternative performance.

### 19. FINAL RESULT CLASSES

Normal numeric research outcomes:

TP
STOP
TIME_EXIT
UNFILLED
INVALIDATED_UNFILLED

UNFILLED:
0R.

INVALIDATED_UNFILLED:
0R.

Market-path ambiguity is resolved by the frozen deterministic
conservative execution convention and therefore must NOT silently
produce a post-hoc AMBIGUOUS exclusion.

Separate non-trading failures:

DATA_UNAVAILABLE
INTEGRITY_FAILURE
SPECIFICATION_FAILURE

These are NOT assigned 0R.

### 20. TRUE DATA UNAVAILABILITY

Examples:

missing required 1m candle
invalid/corrupt OHLC
conflicting duplicate
required confirm != 1
missing reference candle
missing ATR context
missing horizon close
invalid timestamps.

Before outcome analysis:

perform dataset completeness/integrity validation.

For a technically missing/corrupt public-data window:

maximum TWO deterministic re-fetch attempts.

Same rule for all windows.

Record provenance.

Do NOT select between conflicting data versions according to strategy
outcome.

If required data remain unavailable after the frozen recovery process:

primary confirmatory analysis is:

INVALID / NOT INTERPRETABLE.

Do NOT:

drop the episode
replace with 0
replace instrument
change dates.

### 21. IDENTITY CONTROL

Implementation must include an identity-control variant whose geometry,
execution and fees are exactly identical to Baseline.

For every episode:

classification identical
Entry identical
Exit identical
Gross R identical
Net R identical

and:

identityDelta = exactly 0

subject only to shared integrity/data failure.

Identity control is an implementation test.

It is NOT a strategy candidate.

### 22. PRIMARY METRIC

For each valid episode:

baselineEpisodeNetR =
(baselineLongNetR + baselineShortNetR) / 2

alternativeEpisodeNetR =
(alternativeLongNetR + alternativeShortNetR) / 2

deltaEpisode =
alternativeEpisodeNetR - baselineEpisodeNetR

Primary effect:

mean(deltaEpisode)

across all scheduled valid episodes in the corresponding analysis
block.

UNFILLED and INVALIDATED_UNFILLED remain numeric 0R and remain in the
denominator.

Do NOT perform filled-only primary analysis.

### 23. SECONDARY DIAGNOSTICS

Pre-register only:

- fill count/rate
- TP count/rate
- STOP count/rate
- TIME_EXIT count/rate
- UNFILLED count/rate
- INVALIDATED_UNFILLED count/rate
- median episode Net R
- descriptive LONG results
- descriptive SHORT results
- coverage/integrity counts

Secondary diagnostics:

do NOT select candidate
do NOT override failed primary criterion
do NOT justify parameter changes inside v1.0.

No MFE/MAE in v1.0.

### 24. DEPENDENCE / BOOTSTRAP

Use:

7-day moving-block bootstrap of UTC observation days.

Each sampled day carries ALL:

instruments
directions
variants

together.

Development and Holdout are analyzed separately.

Parameters:

10,000 bootstrap repetitions
seed = 20261016
percentile interval
2.5% / 97.5%
Type-7 quantiles.

Blocks are sampled with replacement until original number of
observation days is reached; final block is truncated as needed.

This produces a nominal block-bootstrap uncertainty interval.

Do NOT claim exact finite-sample 95% coverage.

### 25. DEVELOPMENT ADVANCEMENT RULE

There is exactly ONE candidate Alternative.

It advances to sealed Holdout ONLY if:

1. Protocol/config/data integrity PASS.
2. Identity/synthetic execution tests PASS.
3. No unresolved DATA_UNAVAILABLE / integrity failure affecting
   primary population.
4. mean(deltaEpisode) > 0.
5. lower 2.5% bound of the frozen Development block-bootstrap
   interval > 0.

If all five pass:

ADVANCE TO HOLDOUT.

Otherwise:

NO CANDIDATE ADVANCES.

If failure is methodological/data integrity:

INVALID / NOT INTERPRETABLE.

If valid data but criterion 4/5 fails:

NO EVIDENCE OF IMPROVEMENT.

Do NOT create another pullback parameter from Development results
inside v1.0.

Do NOT inspect Holdout if candidate does not advance.

### 26. SEALED HOLDOUT RULE

Holdout remains sealed until Development advancement is formally
recorded.

After opening Holdout, no parameters may change.

Statuses:

CONFIRMED IMPROVEMENT:
- all integrity gates PASS
- mean(deltaEpisode) > 0
- lower 2.5% Holdout bootstrap bound > 0

NOT CONFIRMED:
- valid analysis
- mean(deltaEpisode) <= 0

OR
- upper 97.5% Holdout bootstrap bound < 0

INCONCLUSIVE:
- valid analysis
- mean(deltaEpisode) > 0
- interval includes/touches 0

INVALID / NOT INTERPRETABLE:
- sealing failure
- unresolved required data failure
- execution specification failure
- protocol/config/hash mismatch
- other frozen integrity gate failure.

No second Holdout inspection after changing the model.

### 27. HOLDOUT CLEANLINESS

Before any Development outcome execution, document whether exact
generic daily episodes for the proposed Holdout have previously been
evaluated.

Previous research using 91 SM1M-selected signals is prior knowledge
but is not the same sampling experiment.

If exact generic Holdout outcomes were previously inspected:

STOP.

Do not silently select a new Holdout.

Report contamination and require protocol redesign before outcomes.

### 28. DATASET DESIGN

Use sparse/windowed historical collection.

Do NOT blindly download all continuous 1m history.

For each episode collect/cache only required:

- reference 1m context
- post-observation 1m execution/outcome window through +12h
- last 14 fully closed 1D candles
- necessary technical metadata.

Merge overlapping requests.
Deduplicate by instrument/bar/openTime.
Preserve raw source values.
Preserve confirm field.
Preserve request/data provenance.
Generate deterministic dataset manifest and hashes.

1H data are NOT required for v1.0.

### 29. DATASET SEALING

Before Development outcome execution freeze:

protocol hash
config hash
code commit/hash
universe
calendar
observation schedule
dataset manifest/hash
episode IDs
execution-policy version
fee convention
bootstrap config
selection rule.

Before Holdout opening additionally verify:

Holdout dataset identity
no prior outcome report
Development advancement record.

### 30. PARAMETER SEARCH PROHIBITED

Within v1.0 DO NOT search:

pullback distance
ATR length
Stop distance
Target distance
expiry
horizon
observation time
instrument subset
fee
bootstrap block length
candidate based on subgroup
Long-only / Short-only primary result.

No:

0.15A after 0.25A fails
6h after 4h fails
2A TP after 1A fails
different UTC hour
removing SOL because result is poor
etc.

Any such research requires a NEW development protocol and untouched
validation data.

### 31. RANDOM CONTROL

Do NOT reuse the old 91-signal random control as evidence.

For v1.0, the mandatory null implementation control is the exact
IDENTITY CONTROL.

No additional random-timestamp strategy control is required for the
primary question because sampling timestamps are already fixed
independently of strategy outcomes.

If future research adds a random control, it is a separate
pre-registered diagnostic and cannot retroactively alter v1.0.

### 33. IMPORTANT EXECUTION-TABLE STATUS

R7-B2 freezes the PRINCIPLES of conservative execution.

But historical outcomes MUST NOT run until R7-C creates:

- explicit finite event/state priority table;
- generic plan builder;
- simulator adapter;
- synthetic tests.

If implementation reveals an execution state not resolvable under
this protocol WITHOUT adding a new substantive assumption:

STOP BEFORE OUTCOMES.

Amend protocol transparently before Development is opened.

Do NOT silently decide after seeing a historical result.

## Outstanding R7-C gates

- finite complete execution event/state priority table
- exact first eligible minute convention
- prefill invalidation event priorities
- deterministic PRNG algorithm and bootstrap block indexing
- technical eligibility checks including sufficiently early listing
- secondary diagnostic denominator definitions

These details must be explicit, frozen and synthetic-tested before Development opens. Any required substantive assumption triggers STOP and transparent preregistration amendment before outcomes. This is not permission to choose rules from historical results.

CORE: FROZEN
REAL-MONEY: HOLD
R6: PAUSED
FORWARD: PAUSED
