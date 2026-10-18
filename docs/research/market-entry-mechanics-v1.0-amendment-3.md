# Market entry mechanics v1.0 — Amendment #3

## Pre-outcome freeze and scope

This amendment closes ONLY the outstanding deterministic PRNG algorithm and bootstrap block indexing specification. It is frozen before any real Development outcome calculation or inspection. No runner or outcome simulation is implemented here. Prior protocol, Amendments #1/#2, engine and sealed inputs remain unchanged.

The machine-readable specification below is normative and identical to the companion JSON. Commit references and immutable dataset hashes bind this amendment to the existing experiment. Local pre-outcome verification found no real-result artifact in the Development dataset; no outcome artifact was opened.

## Exact bootstrap mechanics

Use Mulberry32 with unsigned 32-bit initial state `uint32(20261016)`, no hashing or additional entropy. All bit operations use JavaScript semantics and multiplication uses `Math.imul`. The exact transition is included below. Output lies in `[0,1)`.

Initialize once before replicate 1. Use one continuous stream across replicates 1–10000. Advance once per sampled block start, with no extra draws.

The chronological series is 365 UTC observation dates, 2024-11-01 through 2025-10-31, at 17:00 UTC. Each date retains BTC, ETH and SOL paired episode deltas together. LONG/SHORT are dependent members already averaged within each strategy episode. Instruments and directions must never be independently resampled.

Only full, non-circular seven-date source blocks are eligible. Starts are integers 0–358 inclusive (359 starts), sampled with replacement using `floor(u * 359)`. A start s contributes s through s+6 in order.

Each replicate draws 53 starts and constructs 371 candidate positions. Keep the first 365: 52 full blocks contribute 364 positions and only the FIRST date of block 53 is retained. Each retained date contributes all three instruments, yielding exactly 1095 paired deltas. The statistic is their arithmetic mean, with equal episode weights. Total PRNG draws are exactly 530000.

Unexpected non-numeric paired delta causes STOP before primary bootstrap/advancement classification. No dropping, zero replacement, imputation or sample-size change is permitted.

Preserve percentile Type 7 endpoints 0.025/0.975 and all frozen advancement gates: integrity and required-data PASS, identity/synthetic tests PASS, no unresolved primary data failures, positive mean paired delta and strictly positive lower interval bound. No other methodology is changed.

## Deterministic test vectors and full machine-readable specification

The first ten outputs are provided both as round-trip decimal representations and exact unsigned numerators over 4294967296. States are the persistent additive uint32 state. Vectors were independently checked using JavaScript and Python integer arithmetic, without market outcomes. The exact first-replicate starts, states after 10/53/530000 draws, and truncation counts follow.

```json
{
  "protocolVersion": "market-entry-mechanics-v1.0-amendment-3",
  "baseProtocol": "market-entry-mechanics-v1.0",
  "amendment": 3,
  "amendmentTiming": "PRE_OUTCOME",
  "purpose": "Close pending deterministic PRNG algorithm and bootstrap block indexing only",
  "commits": {
    "base": "e3c73966e22e8e5637a76a60a07d34dd6e44b026",
    "amendment1": "b69c3612000a53468849094dd876d8c702485712",
    "engine": "635f661a2215bd3bc75513fd0ff8023bfd65588f",
    "amendment2": "525daf337bbf995af5eade0db7be3723049038a5",
    "collection": "39cfab10e855309d2409555b8b31ca3037699c13"
  },
  "dataset": {
    "sealPath": "/Users/polusmak/analysis/validation/market-entry-r7/development-v1/development-dataset-seal-v1.json",
    "sealSha256": "2e4abdc57f0147fd3bcb8c89ae15be2d3c9d4cff0b45bd68df0e5bf10f6b5d13",
    "inputRootSha256": "9f67bd59f7d3f599b2e99874a5fc35912858d2396b6c45d98ebce29b29e53f24",
    "modified": false
  },
  "preOutcomeState": {
    "realDevelopmentEpisodesExecuted": 0,
    "developmentPerformanceInspected": false,
    "holdoutPerformanceInspected": false,
    "holdoutAccessed": false,
    "runnerImplemented": false
  },
  "prng": {
    "algorithm": "Mulberry32",
    "stateType": "uint32",
    "seed": 20261016,
    "initialState": 20261016,
    "seedMapping": "uint32(20261016); no hashing, string conversion, entropy, system randomness or date/time input",
    "transition": "state = uint32(state + 0x6D2B79F5)\nt = state\nt = imul(t ^ (t >>> 15), t | 1)\nt = t ^ (t + imul(t ^ (t >>> 7), t | 61))\noutput = ((t ^ (t >>> 14)) >>> 0) / 4294967296",
    "semantics": "JavaScript 32-bit bitwise semantics and Math.imul multiplication; persistent state is the additive state, not mixed t",
    "outputRange": "[0,1)",
    "initializations": 1,
    "stream": "one continuous stream across all 10000 replicates; no reseeding",
    "drawsPerBlockStart": 1
  },
  "dates": {
    "start": "2024-11-01",
    "end": "2025-10-31",
    "timezone": "UTC",
    "observationTime": "17:00:00",
    "count": 365,
    "indices": [
      0,
      364
    ],
    "instruments": [
      "BTC-USDT-SWAP",
      "ETH-USDT-SWAP",
      "SOL-USDT-SWAP"
    ],
    "episodesPerDate": 3,
    "episodeCount": 1095
  },
  "blocks": {
    "lengthDays": 7,
    "type": "full non-wrapping moving blocks",
    "startIndicesInclusive": [
      0,
      358
    ],
    "eligibleStartCount": 359,
    "sampleStart": "floor(nextMulberry32Output * 359)",
    "withReplacement": true,
    "independentStartDraws": true,
    "sourceIndices": "s, s+1, s+2, s+3, s+4, s+5, s+6",
    "circular": false,
    "shortenedSourceBlocks": false
  },
  "replicates": {
    "count": 10000,
    "numbering": [
      1,
      10000
    ],
    "drawsPerReplicate": 53,
    "totalDraws": 530000,
    "extraDrawsAllowed": false,
    "construction": "Append sampled full 7-date blocks in within-block chronological order until at least 365 positions; truncate only the final appended tail",
    "candidateDatePositions": 371,
    "retainedDatePositions": 365,
    "first52BlocksPositions": 364,
    "final53rdBlockRetainedPositions": 1,
    "finalBlockRule": "Retain only the FIRST source date of block 53"
  },
  "statistic": {
    "directionAggregation": "For each strategy episodeNetR = (Long NetR + Short NetR) / 2",
    "pairedDelta": "Alternative episodeNetR - Baseline episodeNetR",
    "bootstrapStatistic": "arithmetic mean of all 1095 paired episode deltas in the resampled 365-date list",
    "sameDayDependence": "Each selected date carries all BTC/ETH/SOL episodes together; directions and variants remain attached",
    "independentInstrumentResampling": false,
    "independentDirectionResampling": false,
    "separateInstrumentMeansWithDifferentWeights": false,
    "episodeWeight": "equal; each selected date contributes exactly one paired episode per instrument"
  },
  "nonNumericPrimaryDelta": {
    "action": "STOP before primary bootstrap and advancement classification; report condition",
    "drop": false,
    "zeroReplacement": false,
    "impute": false,
    "changeN": false
  },
  "interval": {
    "method": "percentile",
    "quantileType": 7,
    "probabilities": [
      0.025,
      0.975
    ],
    "coverage": "nominal; not exact finite-sample 95%"
  },
  "advancementRule": "Preserve all frozen base gates including integrity/required-data and identity/synthetic PASS, no unresolved primary failures, mean paired delta > 0 and lower 2.5% bootstrap bound > 0; no threshold or interpretation change",
  "unchanged": [
    "universe",
    "Development dates",
    "Holdout dates",
    "strategies",
    "entry geometry",
    "Stop/Target",
    "fees",
    "episode definition",
    "primary statistic",
    "block length",
    "resample count",
    "seed numeric value",
    "quantile definition",
    "Development advancement rule",
    "engine",
    "Core"
  ],
  "deterministicTestVectors": {
    "first10Outputs": [
      0.18689791089855134,
      0.5267679621465504,
      0.036956520518288016,
      0.19033258804120123,
      0.27266927040182054,
      0.377966626547277,
      0.5112987842876464,
      0.7815919460263103,
      0.38609081716276705,
      0.6261486788280308
    ],
    "first10OutputUint32": [
      802720415,
      2262451170,
      158727047,
      817472241,
      1171105599,
      1623354300,
      2196011557,
      3356911847,
      1658247433,
      2689288098
    ],
    "first10BlockStarts": [
      67,
      189,
      13,
      68,
      97,
      135,
      183,
      280,
      138,
      224
    ],
    "stateAfterDraws": {
      "10": 1156049962,
      "53": 2603968593,
      "530000": 2867745576
    },
    "firstReplicateBlockStarts": [
      67,
      189,
      13,
      68,
      97,
      135,
      183,
      280,
      138,
      224,
      286,
      23,
      217,
      174,
      300,
      155,
      73,
      80,
      333,
      285,
      64,
      273,
      88,
      90,
      45,
      169,
      286,
      92,
      58,
      126,
      285,
      3,
      175,
      221,
      314,
      99,
      188,
      159,
      333,
      298,
      204,
      195,
      349,
      120,
      158,
      4,
      80,
      17,
      80,
      337,
      134,
      105,
      114
    ],
    "candidateDates": 371,
    "retainedDates": 365,
    "finalBlockRetainedDates": 1
  },
  "vectorVerification": "Independent JavaScript canonical transition and Python unsigned-integer arithmetic agree; no Development outcome inputs",
  "finalState": {
    "core": "FROZEN",
    "realMoney": "HOLD",
    "developmentOutcomesExecuted": 0,
    "developmentPerformanceInspected": false,
    "holdoutAccessed": false,
    "r7c3RunnerImplemented": false
  }
}
```

## Freeze boundary

No outcome runner implementation. No real Development outcomes or performance inspected. No Holdout access. No dataset changes. CORE: FROZEN. REAL-MONEY: HOLD.
