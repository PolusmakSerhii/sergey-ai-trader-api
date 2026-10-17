# Market Entry Mechanics v1.0 — Pre-outcome Amendment 2

Data recovery only. This document does not execute or authorize immediate recovery. Base protocol, Amendment 1 and engine remain unchanged.

## Machine-readable specification

```json
{
  "protocolVersion": "market-entry-mechanics-v1.0-amendment-2",
  "baseProtocol": "market-entry-mechanics-v1.0",
  "baseProtocolCommit": "e3c73966e22e8e5637a76a60a07d34dd6e44b026",
  "amendment1Commit": "b69c3612000a53468849094dd876d8c702485712",
  "engineCommit": "635f661a2215bd3bc75513fd0ff8023bfd65588f",
  "amendment": 2,
  "amendmentTiming": "PRE_OUTCOME",
  "reason": "EXHAUSTED_TRANSPORT_RECOVERY",
  "historicalOutcomesInspected": false,
  "developmentPerformanceInspected": false,
  "holdoutPerformanceInspected": false,
  "developmentOpened": false,
  "holdoutOpened": false,
  "recoveryType": "DEFERRED_TRANSPORT_ONLY",
  "originalAttemptsPreserved": true,
  "recoverySessionsPerRequest": 1,
  "maxAdditionalAttempts": 3,
  "maximumLifetimeAttempts": 6,
  "minimumDelaySeconds": 60,
  "holdoutAuthorized": false,
  "executionRequiresSeparateAuthorization": true,
  "scope": "data-recovery semantics only; no trading/execution parameter changes",
  "eligibilityAll": [
    "required Development request",
    "before any strategy outcome inspection",
    "original allowance exhausted",
    "no usable provider payload successfully obtained",
    "existing evidence supports transport/request-completion failure",
    "no proven construction/pagination/parser/validator/cache defect requiring correction",
    "no valid response establishes absent/invalid/unconfirmed/conflicting required data",
    "exact logical request identity unchanged",
    "no prior deferred session except resumption of the SAME session with consumed attempts retained"
  ],
  "nonEligibility": [
    "usable definitive empty/missing response",
    "invalid/unconfirmed/conflicting required records",
    "substantive parser/validator rejection",
    "proven implementation defect",
    "Holdout",
    "strategy outcomes already inspected"
  ],
  "requestIdentity": [
    "provider",
    "instrument",
    "bar",
    "required timestamp window",
    "logical page/request"
  ],
  "delayMeasuredFrom": "completion of preceding deferred attempt to start of next; at least 60 seconds",
  "ledger": "original ledger immutable; separate linked recovery records R1/R2/R3; process restart never resets session or attempt counts",
  "successAll": [
    "usable response",
    "normal parsing",
    "frozen validation",
    "all required candles present and confirmed",
    "integrity PASS",
    "cache persistence success",
    "recovery provenance recorded"
  ],
  "stopImmediatelyOn": [
    "successful recovery",
    "usable response reveals missing/invalid/conflicting/unconfirmed required data",
    "new eligibility disqualification",
    "three additional attempts consumed"
  ],
  "localPersistenceFailure": "no automatic extra provider request justified by this amendment; stop and diagnose locally",
  "generality": "uniform prospective rule for eligible Development requests only; not specific to ETH date",
  "outcomeFirewall": "eligibility never depends on strategy performance",
  "normativeSections": [
    {
      "number": 1,
      "title": "RESEARCH IDENTITY",
      "text": "Verify BEFORE making any change:\n\nBase protocol commit:\ne3c73966e22e8e5637a76a60a07d34dd6e44b026\n\nAmendment #1 commit:\nb69c3612000a53468849094dd876d8c702485712\n\nFrozen engine commit:\n635f661a2215bd3bc75513fd0ff8023bfd65588f\n\nExpected base hashes:\n\nMD:\n2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242\n\nJSON:\n76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c\n\nExpected Amendment #1 hashes:\n\nMD:\n3d4e64c96a13caa13ad6ad7992016eac81f0c796d622453b4f7fa60e2f3b81f3\n\nJSON:\nc6d4873b3d1de4b2ac1675126b591079d5b4cffd60f2284bb89b35fa0b09e11b\n\nExpected engine SHA-256:\n\n5c79833481e6333639ab24b42f2aff5a114a18c9dc00d752c38b3629020ee5e8\n\nIf any required identity/hash does not match:\n\nSTOP.\n\nDo not create Amendment #2."
    },
    {
      "number": 2,
      "title": "FACTUAL BASIS",
      "text": "Record the already-completed R7-C2A forensic findings.\n\nDO NOT perform new network investigation.\n\nProblematic required Development page:\n\nInstrument:\nETH-USDT-SWAP\n\nBar:\n1m\n\nPage opening timestamps:\n2025-02-12 16:59:00 UTC\nthrough\n2025-02-12 21:58:00 UTC\n\nExpected:\n300 consecutive 1m candles.\n\nFinal expected candle close:\n2025-02-12 21:59:00 UTC.\n\nAffected episode:\n\nmarket-entry-mechanics-v1.0:ETH-USDT-SWAP:2025-02-12T17:00:00.000Z\n\nAffected episode count:\n1\n\nLogical request parameters recorded:\n\ninstId=ETH-USDT-SWAP\nbar=1m\nlimit=300\nafter=1739397480001\nbefore=1739379539999\n\nOriginal request + two permitted re-fetch attempts were consumed.\n\nTotal existing attempts:\n3\n\nAttempt 1 recorded:\n\"The operation was aborted due to timeout\"\n\nAttempts 2 and 3 recorded:\n\"fetch failed\"\n\nNo usable provider response body was successfully obtained/persisted.\n\nProvider HTTP status:\nUNKNOWN for these failures.\n\nProvider code/message:\nUNKNOWN.\n\nRequired records present in provider response:\nUNKNOWN.\n\nParser rejection:\nNOT OBSERVED.\n\nValidator rejection:\nNOT OBSERVED.\n\nRaw page successfully persisted:\nNO.\n\nRequest-construction defect:\nNOT PROVEN.\n\nPagination defect:\nNOT PROVEN.\n\nParser defect:\nNOT PROVEN.\n\nValidator defect:\nNOT PROVEN.\n\nCache/resume defect:\nNOT PROVEN.\n\nTrue provider historical-data unavailability:\nNOT PROVEN.\n\nForensic classification:\n\nPROVIDER_TRANSIENT / TRANSPORT FAILURE\n\nExact underlying network cause:\n\nINSUFFICIENT_EVIDENCE.\n\nAlso record:\n\nsix other ETH windows showed similar transport-failure behavior;\n\nfive recovered on their second attempt;\n\none recovered on its third attempt;\n\nonly the current required page exhausted the original allowance.\n\nThis supports transient transport failure as a real collection issue,\nbut does NOT prove that the missing page is available from OKX."
    },
    {
      "number": 3,
      "title": "PURPOSE OF AMENDMENT #2",
      "text": "The original recovery rule did not sufficiently distinguish:\n\nA. a usable provider response proving/indicating an actual\n   data-integrity or availability problem;\n\nfrom\n\nB. a transport/request-completion failure where no usable provider\n   payload was obtained.\n\nAmendment #2 introduces ONE bounded deferred recovery session for\ncategory B only.\n\nThis amendment is made:\n\nPRE-OUTCOME\nBEFORE Development performance inspection\nBEFORE Holdout performance inspection\nBEFORE R7-C3.\n\nIt does NOT authorize unlimited retries.\n\nIt does NOT alter trading/execution methodology."
    },
    {
      "number": 4,
      "title": "ORIGINAL LEDGER IS IMMUTABLE",
      "text": "The existing three attempts remain consumed.\n\nThey MUST NOT be:\n\nreset;\ndeleted;\nrenumbered as if they never occurred;\nreclassified as non-attempts;\noverwritten;\nremoved from provenance.\n\nThe new recovery session, if later separately authorized, adds new\nrecords linked to the same request identity.\n\nFor the current failed request:\n\nOriginal attempts:\n1\n2\n3\n\nremain permanently recorded."
    },
    {
      "number": 5,
      "title": "DEFERRED RECOVERY ELIGIBILITY",
      "text": "A required DEVELOPMENT request may enter deferred transport recovery\nONLY when ALL conditions below are true:\n\n1. The original retry allowance is exhausted.\n\n2. No usable provider payload was successfully obtained for the\n   required request.\n\n3. Existing evidence identifies the failures as transport-level or\n   request-completion failures occurring before a usable provider\n   payload can be processed.\n\nExamples may include:\n\ntimeout\nconnection failure\nfetch transport failure\nDNS interruption\nTLS interruption\nsocket interruption\nequivalent transport/request-completion failure.\n\n4. There is NO proven:\n\nrequest-construction defect;\npagination defect;\nparser defect;\nvalidator defect;\ncache/resume defect\n\nthat must first be corrected.\n\n5. There is NO valid provider response establishing that required\nhistorical data are actually unavailable, missing, invalid or\nconflicting.\n\n6. Exact logical request identity remains unchanged.\n\nIf all conditions are not satisfied:\n\ndeferred transport recovery is NOT authorized by Amendment #2."
    },
    {
      "number": 6,
      "title": "NOT ELIGIBLE",
      "text": "Amendment #2 MUST NOT be used to repeatedly query after:\n\n- a usable provider response definitively returns required data absent;\n\n- a valid definitive empty provider result;\n\n- provider response contains conflicting required data;\n\n- required candle is returned but invalid;\n\n- required candle is unconfirmed;\n\n- parser rejects provider payload for a substantive data reason;\n\n- validator rejects required data;\n\n- a request-construction defect is proven;\n\n- a pagination defect is proven;\n\n- a cache/resume defect is proven.\n\nThose situations require normal integrity handling or a separate\npre-outcome methodology decision.\n\nTransport recovery MUST NOT be used to search for a more favorable\nhistorical data version."
    },
    {
      "number": 7,
      "title": "DEFERRED RECOVERY BUDGET",
      "text": "For each eligible exhausted request identity:\n\nallow exactly ONE deferred transport-recovery session.\n\nMaximum additional attempts in that session:\n\n3.\n\nFor the current ETH request:\n\nexisting original attempts:\n1\n2\n3\n\npossible deferred recovery attempts:\n\nR1\nR2\nR3\n\nMaximum lifetime provider requests for this exact request identity\nunder protocol + Amendment #2:\n\n6.\n\nNo second deferred recovery session exists.\n\nIf R1 succeeds:\nR2 and R3 MUST NOT execute.\n\nIf R1 fails and R2 succeeds:\nR3 MUST NOT execute.\n\nIf R1-R3 all fail:\nrecovery budget is exhausted.\n\nNo silent seventh request is permitted."
    },
    {
      "number": 8,
      "title": "FIXED DELAY",
      "text": "Between deferred recovery attempts:\n\nwait at least 60 seconds.\n\nDo NOT rapidly issue R1/R2/R3.\n\nThis delay applies between:\n\nR1 -> R2\nR2 -> R3.\n\nIf a usable successful response is obtained, recovery terminates\nimmediately."
    },
    {
      "number": 9,
      "title": "REQUEST IDENTITY MUST REMAIN UNCHANGED",
      "text": "Deferred recovery must use the exact same frozen data source and\nlogical request identity.\n\nProvider:\n\nOKX public historical market candles.\n\nInstrument:\nunchanged.\n\nBar:\nunchanged.\n\nRequired timestamp window:\nunchanged.\n\nNo SPOT fallback.\n\nNo alternative exchange.\n\nNo substituted instrument.\n\nNo shifted date.\n\nNo strategy-dependent narrowing or widening of the requested window.\n\nNo request modification based on trading outcome.\n\nExisting provider mechanics may be used only insofar as they represent\nthe same logical frozen page/request."
    },
    {
      "number": 10,
      "title": "RECOVERY SUCCESS CONDITION",
      "text": "A later separately-authorized recovery attempt succeeds only when:\n\n1. a usable provider response is obtained;\n\n2. required page can be parsed normally;\n\n3. normal frozen validation passes;\n\n4. required candles are present;\n\n5. confirmation requirements pass;\n\n6. integrity requirements pass;\n\n7. cache persistence succeeds;\n\n8. recovery provenance is recorded.\n\nAfter successful recovery:\n\nnormal R7-C2 completeness/validation may resume.\n\nAmendment #2 itself does NOT seal the Development dataset."
    },
    {
      "number": 11,
      "title": "RECOVERY FAILURE CONDITION",
      "text": "If R1, R2 and R3 all fail due eligible transport failures:\n\nDEVELOPMENT DATASET SEALED = NO\n\nDATA COMPLETENESS = FAIL\n\nSTOP.\n\nNo further transport recovery is authorized under v1.0.\n\nIf R1/R2/R3 obtains a usable provider response but that response\nreveals actual missing/invalid/conflicting required data:\n\nSTOP transport recovery immediately.\n\nDo NOT consume remaining recovery attempts trying to obtain a\ndifferent provider answer.\n\nHandle the result under the frozen data-integrity rules."
    },
    {
      "number": 12,
      "title": "GENERALITY",
      "text": "Amendment #2 is NOT specific only to:\n\nETH-USDT-SWAP\n2025-02-12.\n\nThe same rule applies prospectively and uniformly to any required\nDEVELOPMENT request in this v1.0 dataset build that:\n\n- exhausts the original retry allowance;\n\n- meets all transport-only eligibility requirements;\n\n- occurs before Development outcomes are opened.\n\nEach exact request identity may receive:\n\nat most ONE deferred recovery session;\n\nat most THREE additional attempts.\n\nNo Holdout request is authorized by this amendment."
    },
    {
      "number": 13,
      "title": "OUTCOME FIREWALL",
      "text": "Recovery eligibility and execution may depend ONLY on:\n\ntransport/request completion status;\nprovider payload availability;\ndata completeness;\ndata integrity;\ncache/provenance success.\n\nIt may NOT depend on:\n\nBaseline outcome;\nAlternative outcome;\nTP;\nSTOP;\nTIME_EXIT result;\nGrossR;\nNetR;\nepisode delta;\nwin/loss;\nmean delta;\nbootstrap;\nprofit factor;\nany strategy-performance measure.\n\nRecord:\n\nhistorical strategy outcomes inspected = false\nDevelopment performance inspected = false\nHoldout performance inspected = false."
    },
    {
      "number": 14,
      "title": "HOLDOUT FIREWALL",
      "text": "Amendment #2 authorizes NO Holdout requests.\n\nIt authorizes NO Holdout recovery.\n\nIt authorizes NO Holdout dataset construction.\n\nIt authorizes NO Holdout outcome inspection.\n\nHoldout remains SEALED."
    },
    {
      "number": 15,
      "title": "VERSIONING",
      "text": "Create exactly:\n\ndocs/research/market-entry-mechanics-v1.0-amendment-2.md\n\ndocs/research/market-entry-mechanics-v1.0-amendment-2.json\n\nIdentifier:\n\nmarket-entry-mechanics-v1.0-amendment-2\n\nMachine-readable document must include at least:\n\nbaseProtocol\nbaseProtocolCommit\namendment1Commit\nengineCommit\n\namendment = 2\n\namendmentTiming = PRE_OUTCOME\n\nreason = EXHAUSTED_TRANSPORT_RECOVERY\n\nhistoricalOutcomesInspected = false\n\ndevelopmentPerformanceInspected = false\n\nholdoutPerformanceInspected = false\n\ndevelopmentOpened = false\n\nholdoutOpened = false\n\nrecoveryType = DEFERRED_TRANSPORT_ONLY\n\noriginalAttemptsPreserved = true\n\nrecoverySessionsPerRequest = 1\n\nmaxAdditionalAttempts = 3\n\nminimumDelaySeconds = 60\n\nholdoutAuthorized = false\n\nRecord explicitly:\n\nAmendment #2 modifies ONLY data-recovery semantics.\n\nIt does NOT change:\n\nuniverse;\nobservation time;\nP0;\nATR;\nBaseline;\nAlternative;\nEntry;\nStop;\nTarget;\nexpiry;\nhorizon;\nfees;\nepisode construction;\nprimary metric;\nbootstrap;\nadvancement criterion;\nHoldout criterion;\nexecution engine semantics."
    },
    {
      "number": 16,
      "title": "PRE-COMMIT LOOPHOLE AUDIT",
      "text": "Before creating final commit, verify Amendment #2 cannot authorize:\n\n1. unlimited retries;\n\n2. more than one recovery session per request identity;\n\n3. recovery after a valid definitive provider response establishing\n   missing data;\n\n4. recovery after strategy outcomes are inspected;\n\n5. Holdout download/recovery;\n\n6. provider substitution;\n\n7. instrument substitution;\n\n8. date substitution;\n\n9. bar/timeframe substitution;\n\n10. retry-ledger reset;\n\n11. deletion/reclassification of original failed attempts;\n\n12. outcome-dependent recovery;\n\n13. repeated requests after R1/R2/R3 budget exhaustion;\n\n14. use of recovery to obtain a preferred historical answer.\n\nIf ANY loophole remains:\n\nSTOP.\n\nDo not freeze Amendment #2.\n\nReport exact blocker."
    }
  ],
  "frozenHashes": {
    "market-entry-mechanics-v1.0.md": "2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242",
    "market-entry-mechanics-v1.0.json": "76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c",
    "market-entry-mechanics-v1.0-amendment-1.md": "3d4e64c96a13caa13ad6ad7992016eac81f0c796d622453b4f7fa60e2f3b81f3",
    "market-entry-mechanics-v1.0-amendment-1.json": "c6d4873b3d1de4b2ac1675126b591079d5b4cffd60f2284bb89b35fa0b09e11b"
  },
  "engineSha256": "5c79833481e6333639ab24b42f2aff5a114a18c9dc00d752c38b3629020ee5e8"
}
```

## Normative rules and factual basis

### 1. RESEARCH IDENTITY

Verify BEFORE making any change:

Base protocol commit:
e3c73966e22e8e5637a76a60a07d34dd6e44b026

Amendment #1 commit:
b69c3612000a53468849094dd876d8c702485712

Frozen engine commit:
635f661a2215bd3bc75513fd0ff8023bfd65588f

Expected base hashes:

MD:
2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242

JSON:
76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c

Expected Amendment #1 hashes:

MD:
3d4e64c96a13caa13ad6ad7992016eac81f0c796d622453b4f7fa60e2f3b81f3

JSON:
c6d4873b3d1de4b2ac1675126b591079d5b4cffd60f2284bb89b35fa0b09e11b

Expected engine SHA-256:

5c79833481e6333639ab24b42f2aff5a114a18c9dc00d752c38b3629020ee5e8

If any required identity/hash does not match:

STOP.

Do not create Amendment #2.

### 2. FACTUAL BASIS

Record the already-completed R7-C2A forensic findings.

DO NOT perform new network investigation.

Problematic required Development page:

Instrument:
ETH-USDT-SWAP

Bar:
1m

Page opening timestamps:
2025-02-12 16:59:00 UTC
through
2025-02-12 21:58:00 UTC

Expected:
300 consecutive 1m candles.

Final expected candle close:
2025-02-12 21:59:00 UTC.

Affected episode:

market-entry-mechanics-v1.0:ETH-USDT-SWAP:2025-02-12T17:00:00.000Z

Affected episode count:
1

Logical request parameters recorded:

instId=ETH-USDT-SWAP
bar=1m
limit=300
after=1739397480001
before=1739379539999

Original request + two permitted re-fetch attempts were consumed.

Total existing attempts:
3

Attempt 1 recorded:
"The operation was aborted due to timeout"

Attempts 2 and 3 recorded:
"fetch failed"

No usable provider response body was successfully obtained/persisted.

Provider HTTP status:
UNKNOWN for these failures.

Provider code/message:
UNKNOWN.

Required records present in provider response:
UNKNOWN.

Parser rejection:
NOT OBSERVED.

Validator rejection:
NOT OBSERVED.

Raw page successfully persisted:
NO.

Request-construction defect:
NOT PROVEN.

Pagination defect:
NOT PROVEN.

Parser defect:
NOT PROVEN.

Validator defect:
NOT PROVEN.

Cache/resume defect:
NOT PROVEN.

True provider historical-data unavailability:
NOT PROVEN.

Forensic classification:

PROVIDER_TRANSIENT / TRANSPORT FAILURE

Exact underlying network cause:

INSUFFICIENT_EVIDENCE.

Also record:

six other ETH windows showed similar transport-failure behavior;

five recovered on their second attempt;

one recovered on its third attempt;

only the current required page exhausted the original allowance.

This supports transient transport failure as a real collection issue,
but does NOT prove that the missing page is available from OKX.

### 3. PURPOSE OF AMENDMENT #2

The original recovery rule did not sufficiently distinguish:

A. a usable provider response proving/indicating an actual
   data-integrity or availability problem;

from

B. a transport/request-completion failure where no usable provider
   payload was obtained.

Amendment #2 introduces ONE bounded deferred recovery session for
category B only.

This amendment is made:

PRE-OUTCOME
BEFORE Development performance inspection
BEFORE Holdout performance inspection
BEFORE R7-C3.

It does NOT authorize unlimited retries.

It does NOT alter trading/execution methodology.

### 4. ORIGINAL LEDGER IS IMMUTABLE

The existing three attempts remain consumed.

They MUST NOT be:

reset;
deleted;
renumbered as if they never occurred;
reclassified as non-attempts;
overwritten;
removed from provenance.

The new recovery session, if later separately authorized, adds new
records linked to the same request identity.

For the current failed request:

Original attempts:
1
2
3

remain permanently recorded.

### 5. DEFERRED RECOVERY ELIGIBILITY

A required DEVELOPMENT request may enter deferred transport recovery
ONLY when ALL conditions below are true:

1. The original retry allowance is exhausted.

2. No usable provider payload was successfully obtained for the
   required request.

3. Existing evidence identifies the failures as transport-level or
   request-completion failures occurring before a usable provider
   payload can be processed.

Examples may include:

timeout
connection failure
fetch transport failure
DNS interruption
TLS interruption
socket interruption
equivalent transport/request-completion failure.

4. There is NO proven:

request-construction defect;
pagination defect;
parser defect;
validator defect;
cache/resume defect

that must first be corrected.

5. There is NO valid provider response establishing that required
historical data are actually unavailable, missing, invalid or
conflicting.

6. Exact logical request identity remains unchanged.

If all conditions are not satisfied:

deferred transport recovery is NOT authorized by Amendment #2.

### 6. NOT ELIGIBLE

Amendment #2 MUST NOT be used to repeatedly query after:

- a usable provider response definitively returns required data absent;

- a valid definitive empty provider result;

- provider response contains conflicting required data;

- required candle is returned but invalid;

- required candle is unconfirmed;

- parser rejects provider payload for a substantive data reason;

- validator rejects required data;

- a request-construction defect is proven;

- a pagination defect is proven;

- a cache/resume defect is proven.

Those situations require normal integrity handling or a separate
pre-outcome methodology decision.

Transport recovery MUST NOT be used to search for a more favorable
historical data version.

### 7. DEFERRED RECOVERY BUDGET

For each eligible exhausted request identity:

allow exactly ONE deferred transport-recovery session.

Maximum additional attempts in that session:

3.

For the current ETH request:

existing original attempts:
1
2
3

possible deferred recovery attempts:

R1
R2
R3

Maximum lifetime provider requests for this exact request identity
under protocol + Amendment #2:

6.

No second deferred recovery session exists.

If R1 succeeds:
R2 and R3 MUST NOT execute.

If R1 fails and R2 succeeds:
R3 MUST NOT execute.

If R1-R3 all fail:
recovery budget is exhausted.

No silent seventh request is permitted.

### 8. FIXED DELAY

Between deferred recovery attempts:

wait at least 60 seconds.

Do NOT rapidly issue R1/R2/R3.

This delay applies between:

R1 -> R2
R2 -> R3.

If a usable successful response is obtained, recovery terminates
immediately.

### 9. REQUEST IDENTITY MUST REMAIN UNCHANGED

Deferred recovery must use the exact same frozen data source and
logical request identity.

Provider:

OKX public historical market candles.

Instrument:
unchanged.

Bar:
unchanged.

Required timestamp window:
unchanged.

No SPOT fallback.

No alternative exchange.

No substituted instrument.

No shifted date.

No strategy-dependent narrowing or widening of the requested window.

No request modification based on trading outcome.

Existing provider mechanics may be used only insofar as they represent
the same logical frozen page/request.

### 10. RECOVERY SUCCESS CONDITION

A later separately-authorized recovery attempt succeeds only when:

1. a usable provider response is obtained;

2. required page can be parsed normally;

3. normal frozen validation passes;

4. required candles are present;

5. confirmation requirements pass;

6. integrity requirements pass;

7. cache persistence succeeds;

8. recovery provenance is recorded.

After successful recovery:

normal R7-C2 completeness/validation may resume.

Amendment #2 itself does NOT seal the Development dataset.

### 11. RECOVERY FAILURE CONDITION

If R1, R2 and R3 all fail due eligible transport failures:

DEVELOPMENT DATASET SEALED = NO

DATA COMPLETENESS = FAIL

STOP.

No further transport recovery is authorized under v1.0.

If R1/R2/R3 obtains a usable provider response but that response
reveals actual missing/invalid/conflicting required data:

STOP transport recovery immediately.

Do NOT consume remaining recovery attempts trying to obtain a
different provider answer.

Handle the result under the frozen data-integrity rules.

### 12. GENERALITY

Amendment #2 is NOT specific only to:

ETH-USDT-SWAP
2025-02-12.

The same rule applies prospectively and uniformly to any required
DEVELOPMENT request in this v1.0 dataset build that:

- exhausts the original retry allowance;

- meets all transport-only eligibility requirements;

- occurs before Development outcomes are opened.

Each exact request identity may receive:

at most ONE deferred recovery session;

at most THREE additional attempts.

No Holdout request is authorized by this amendment.

### 13. OUTCOME FIREWALL

Recovery eligibility and execution may depend ONLY on:

transport/request completion status;
provider payload availability;
data completeness;
data integrity;
cache/provenance success.

It may NOT depend on:

Baseline outcome;
Alternative outcome;
TP;
STOP;
TIME_EXIT result;
GrossR;
NetR;
episode delta;
win/loss;
mean delta;
bootstrap;
profit factor;
any strategy-performance measure.

Record:

historical strategy outcomes inspected = false
Development performance inspected = false
Holdout performance inspected = false.

### 14. HOLDOUT FIREWALL

Amendment #2 authorizes NO Holdout requests.

It authorizes NO Holdout recovery.

It authorizes NO Holdout dataset construction.

It authorizes NO Holdout outcome inspection.

Holdout remains SEALED.

### 15. VERSIONING

Create exactly:

docs/research/market-entry-mechanics-v1.0-amendment-2.md

docs/research/market-entry-mechanics-v1.0-amendment-2.json

Identifier:

market-entry-mechanics-v1.0-amendment-2

Machine-readable document must include at least:

baseProtocol
baseProtocolCommit
amendment1Commit
engineCommit

amendment = 2

amendmentTiming = PRE_OUTCOME

reason = EXHAUSTED_TRANSPORT_RECOVERY

historicalOutcomesInspected = false

developmentPerformanceInspected = false

holdoutPerformanceInspected = false

developmentOpened = false

holdoutOpened = false

recoveryType = DEFERRED_TRANSPORT_ONLY

originalAttemptsPreserved = true

recoverySessionsPerRequest = 1

maxAdditionalAttempts = 3

minimumDelaySeconds = 60

holdoutAuthorized = false

Record explicitly:

Amendment #2 modifies ONLY data-recovery semantics.

It does NOT change:

universe;
observation time;
P0;
ATR;
Baseline;
Alternative;
Entry;
Stop;
Target;
expiry;
horizon;
fees;
episode construction;
primary metric;
bootstrap;
advancement criterion;
Holdout criterion;
execution engine semantics.

### 16. PRE-COMMIT LOOPHOLE AUDIT

Before creating final commit, verify Amendment #2 cannot authorize:

1. unlimited retries;

2. more than one recovery session per request identity;

3. recovery after a valid definitive provider response establishing
   missing data;

4. recovery after strategy outcomes are inspected;

5. Holdout download/recovery;

6. provider substitution;

7. instrument substitution;

8. date substitution;

9. bar/timeframe substitution;

10. retry-ledger reset;

11. deletion/reclassification of original failed attempts;

12. outcome-dependent recovery;

13. repeated requests after R1/R2/R3 budget exhaustion;

14. use of recovery to obtain a preferred historical answer.

If ANY loophole remains:

STOP.

Do not freeze Amendment #2.

Report exact blocker.

## Loophole audit

All 14 prohibited authorizations checked: PASS. One session/request survives process restarts; prior attempts remain consumed. The 60-second delay is measured after the preceding deferred attempt completes. A usable substantive data failure ends transport recovery immediately. Local persistence failure cannot justify obtaining a preferred provider version. No Holdout access or outcome-dependent eligibility. Existing ledger/cache are not modified by this documentation task.

CORE: FROZEN
REAL-MONEY: HOLD
DEVELOPMENT OUTCOMES: CLOSED
HOLDOUT: SEALED
R7-C3: NOT STARTED
