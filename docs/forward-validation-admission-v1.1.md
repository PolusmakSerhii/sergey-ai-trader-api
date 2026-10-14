# SM1M Forward Validation Admission Semantics v1.1

## 1. Document status

- Status: PREREGISTERED BEFORE FORWARD ACTIVATION
- Parent protocol: `docs/forward-validation-protocol-v1.1.md`
- Parent protocol commit: `c1d150de78fd5139ffb8799fa5b36916801ed52c`
- Forward Protocol v1.1: FROZEN, unchanged
- Forward cohort: NOT STARTED
- Forward activation timestamp: NOT SET
- First eligible Forward signal: NOT SET
- Real-money activation: HOLD
- Core: FROZEN
- Historical exploratory analysis: CLOSED

This addendum defines only the isolated Forward overlay. It does NOT change canonical A+, frozen Entry Plan, Entry Zone, SL/TP1, lifecycle price logic, TP1 reanalysis, HOLD/CLOSE, historical Statistics, or historical records. The parent protocol remains unchanged. No activation timestamp is assigned.

## 2. Forward signal identity

ONE Forward signal = ONE newly created canonical frozen setup with a new immutable Core trade identity.

Repeated scanner observations / refreshes of the same frozen setup are NOT new Forward signals.

Existing Core identity semantics:

- `setupKey = symbol:direction`
- `tradeId = setupKey:capturedAt` for a newly created setup.
- Existing tradeId and initialPlan remain frozen/preserved on updates.

If the same symbol:direction remains an existing open Core setup, later A+ observations that reuse that Core identity are observations of the SAME Forward signal, not additional Forward trades.

After the prior Core setup is terminal, a genuinely new canonical frozen Core identity may become a new Forward signal.

For prospective completeness, canonical candidates must be captured for the Forward ledger BEFORE ranking truncation such as `slice(0,20)`. Capture must use the same canonical A+ gate, not create a new trading gate, not create duplicate trades from scanner refreshes, not alter Core trade identity semantics, and preserve every eligible new Forward identity.

## 3. Forward states

Minimum overlay states:

- DETECTED
- WAITING_ENTRY
- UNRESOLVED_VERIFICATION
- ADMITTED
- SKIPPED_MISSED_ENTRY
- SKIPPED_CAPACITY
- SKIPPED_DATA_FAILURE
- COMPLETED

These Forward overlay states do NOT replace Core lifecycle states.

UNRESOLVED_VERIFICATION must preserve priorDisposition, whether capacity is currently occupied, verification cursor/progress, reason/evidence, and immutable admission decisions already made.

SKIPPED_DATA_FAILURE has NO permitted final transition unless a future preregistered protocol version/addendum defines an objective closure rule BEFORE affected observations. Until then verification failures remain UNRESOLVED_VERIFICATION.

## 4. Eligible entry event

`eligibleEntryCandle.timestamp` is the start timestamp of the confirmed 1-minute candle whose frozen Entry Zone evidence establishes the first eligible model entry event.

It is a model event timestamp with 1-minute resolution, NOT an exact intrabar touch time. No unconfirmed candle may create an admission decision. Missing/ambiguous evidence → UNRESOLVED_VERIFICATION.

## 5. Deterministic admission order

Comparator:

1. eligibleEntryCandle.timestamp ASC
2. origin.detectedAt ASC
3. tradeId ASC using deterministic lexical/code-point ordering, not locale-dependent ordering.

Do NOT use Opportunity Score, Confidence, Recommendation confidence, later P&L, later lifecycle result, or discretionary human selection as admission priority. Candidates from the same minute are ordered only by this comparator.

## 6. Capacity rules

- Maximum 3 simultaneous admitted model positions.
- Maximum 2 simultaneous admitted positions in the same direction.
- Maximum 1 simultaneous admitted position per instrument.

Capacity is checked at the candidate's FIRST eligible entry event. If any 3/2/1 rule prevents admission, final disposition for that Forward identity is SKIPPED_CAPACITY.

This decision is FINAL for that identity. Do NOT wait for a later Entry Zone touch or reactivate the same identity after capacity becomes available. A later trade requires a genuinely new Core frozen identity.

## 7. Capacity occupancy

An ADMITTED Forward position consumes exactly one position slot. Slot size does NOT depend on remaining position fraction.

The slot remains occupied through Active, TP1 with remaining 50%, HOLD, pending CLOSE, and temporary verification/data failure.

TP1 and HOLD do NOT release capacity. A temporary verification failure does NOT release capacity for an already admitted position. Capacity is released only after a confirmed terminal model execution.

## 8. Terminal release

Under current `tp1-50-reanalyse-v1`, the position remains open after TP1 and becomes terminal only through confirmed model closure such as Stopped or Closed.

Legacy terminal states may include TP3Hit or historical TP1Hit depending on policy/version. Expired never consumed an admitted position slot if the setup was never admitted.

The Forward layer derives release only from confirmed lifecycle evidence. Never fabricate an exit timestamp. Current candle lifecycle records terminal checkedAt at the confirming candle's end; this is not a claim of exact intrabar execution time.

## 9. Same-minute EXIT / ENTRY rule

A capacity slot released by a terminal event occurring in confirmed 1-minute candle T MUST NOT be reused for another admission whose eligible entry event is also candle T.

OHLC evidence does not establish reliable cross-instrument intrabar chronology.

For an entry candle starting at T, only capacity releases already confirmed with release/checkedAt <= T may be used. A terminal event inside candle [T, T+60s) becomes available for admissions beginning with the NEXT minute.

### Example A

3 slots occupied before T. Position #1 stops during candle T. Candidate #4 touches Entry Zone during T. Result: #4 cannot use #1's slot during T.

### Example B

3 slots occupied. Position #1 reaches TP1 during T but remaining 50% stays open. Candidate #4 touches during T. Result: #4 cannot be admitted from that slot. TP1 does not release it.

### Example C

One slot free. Two candidates have first eligible entry events during T. Apply the deterministic admission comparator. First candidate satisfying 3/2/1 is ADMITTED. The competing candidate blocked by capacity becomes SKIPPED_CAPACITY.

A trade that enters and reaches a terminal outcome inside its own entry candle still consumes its slot for all other admissions in that same minute.

## 10. Processing watermark

A chronological processing watermark is required. No final admission decision for time T may be made while an unresolved candidate or occupied-position event at an earlier relevant time could still change capacity at T.

For competing candidates in the same minute, capacity assignment must not be finalized until all candidates that could participate in that minute's deterministic comparator are known and sufficiently verified.

The watermark must be based only on information/evidence available prospectively. No later P&L or outcome may influence admission ordering.

Incomplete required evidence holds affected decisions as UNRESOLVED_VERIFICATION. Do not guess occupancy or use current wall-clock time as substitute event evidence.

## 11. MISSED ENTRY

SKIPPED_MISSED_ENTRY is final ONLY when all are true:

- The Forward setup was never ADMITTED.
- Frozen plan and entry time boundaries are valid.
- Required sequential entry-window verification reached the expiry boundary.
- No unresolved candle gaps remain.
- No ambiguous entry/boundary evidence remains.
- No eligible frozen Entry Zone touch occurred.
- Persisted lifecycle evidence supports verified expiry.

Wall-clock expiry alone is NOT sufficient. An unverified data gap MUST NOT be converted to MISSED ENTRY.

## 12. Verification failure

DATA/VERIFICATION FAILURE is initially NOT a final skip. Use UNRESOLVED_VERIFICATION and retry when evidence becomes available.

There is NO arbitrary 24h, 48h, 72h, or N-retry timeout for converting verification failure to a final skip. Do NOT invent one.

SKIPPED_DATA_FAILURE remains a reserved state with no permitted final transition under this addendum. A future objective closure rule, if needed, must be preregistered BEFORE it affects observations and must create a new protocol/addendum version if required.

## 13. ALL FORWARD A+ and CLEAN MODEL-TRADED

### ALL FORWARD A+

Contains every captured Forward identity created after activation, regardless of later disposition.

### CLEAN MODEL-TRADED

Contains only Forward identities that passed deterministic admission, were marked ADMITTED, were not invalidated by a P0/P1 measurement/integrity defect, and obtained a confirmed terminal model result according to frozen lifecycle semantics.

SKIPPED_CAPACITY and SKIPPED_MISSED_ENTRY remain in ALL FORWARD A+ but do not enter CLEAN MODEL-TRADED. UNRESOLVED_VERIFICATION remains visible and is NOT silently removed from ALL FORWARD A+.

Do NOT retrospectively choose trades after seeing outcomes.

## 14. Fail-closed principle

When identity, event timestamp, verification completeness, occupancy, admission ordering, or terminal evidence cannot be proved, fail closed for CLEAN MODEL-TRADED classification. The observation may remain unresolved.

MUST NOT fabricate TRADED, SKIPPED, entry, exit, or model R; MUST NOT use later outcome to resolve earlier admission competition.

## 15. Core separation

This admission/tracking layer is an observational/validation overlay. It MUST NOT change:

- canonical confirmed A+ definition;
- Opportunity Grade;
- frozen Entry Zone;
- planned Entry;
- frozen SL;
- frozen TP1;
- Entry touch price logic;
- Core lifecycle;
- tp1-50-reanalyse-v1;
- HOLD/CLOSE decision engine;
- existing historical Statistics semantics;
- historical Validation Archive records.

It may decide whether a Core model entry belongs to Forward CLEAN MODEL-TRADED under preregistered capacity rules. This is cohort/admission validation logic, not a new trading strategy filter.

## 16. Anti-Chase separation

Future Anti-Chase telemetry is observational only and independent from Forward admission. Anti-Chase metrics MUST NOT affect admission, 3/2/1, entry priority, TRADED/SKIPPED, or Positive Gate unless a future separately preregistered protocol explicitly changes those rules.

## 17. Activation

This document MUST NOT activate Forward.

- Forward activation timestamp: NOT SET
- First eligible Forward signal: NOT SET
- Forward cohort: NOT STARTED
- Real-money activation: HOLD

Implementation/testing of the overlay occurs BEFORE activation. Activation requires a separate deliberate action after operational readiness is verified.

## 18. Immutability

After Forward activation, these admission semantics are immutable for that cohort. Any material change to identity, comparator, 3/2/1, capacity release, same-minute rule, watermark, or final skip semantics requires a new version/effective timestamp and cohort split where applicable.

## 19. Documentation-only scope

This preregistration does not implement or start the overlay. Parent v1.1, v1.0, Core code, tests, research runner, frontend and historical records remain unchanged. No network, Production, Redis or provider/API requests. No deploy, commit or push is authorized by this documentation task.
