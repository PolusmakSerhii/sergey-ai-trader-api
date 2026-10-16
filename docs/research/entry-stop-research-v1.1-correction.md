# Historical Entry/Stop Research v1.1 — Corrected Replication

Status: PREREGISTERED CORRECTED REPLICATION — DOCUMENTATION ONLY.
Historical execution is NOT authorized by this document. STOP BEFORE COMMIT.

## Disclosure and source

This is a CORRECTED REPLICATION, not a new independent experiment or independent preregistered confirmation. The v1.0 results were already inspected. The expiry issue was identified AFTER those results. Replacing the all-four primary denominator with a V1/V0 paired-available denominator is an intentional methodology change AFTER viewing v1.0, explicitly approved by the user; it is not merely a simulator bug fix. Neither change is concealed as a pre-result decision. v1.0 remains permanently preserved.

Source protocol: docs/research/entry-stop-research-v1.0.md and .json, commit 3030f53eb70272e88c0ec7c668a8a2c549f6a447.
Simulator: 7db5d2d75986469aa4fee2714ffdeea55a2d5f7a.
Random control: ae8a698ae2310d80fdc39260edd45ee57d16d261.
Archive SHA-256: ab17a8429926a3cd6a21e96aa7883f2f64e0fdb4a45518de3309ce82cf28bac2.
Canonical v1.0 config SHA-256: 0f14306352dd30abe08bbafc7b87058dd52dbb4b300faa5196d7146676c614c1.
First and only v1.0 run: 2026-10-16T16:19:58.180Z (16:19:58 UTC).

Original report: /Users/polusmak/analysis/validation/entry-stop-v1-results/aggregate-report.md.
Forensics: /Users/polusmak/analysis/validation/entry-stop-v1-results/attrition-forensics.md.
Neither these nor any original artifacts may be overwritten. The JSON companion records their hashes and exact original 91 tradeIds.

## Disclosed defect

V1 DATA_UNAVAILABLE = 25, all PARTIAL_EXPIRY_MINUTE; this was not missing OKX candle coverage. simulate() returned DATA_UNAVAILABLE at a non-minute-aligned expiry before reading the boundary candle. ATTRITION BIAS RISK: MATERIAL. SUSPECTED SIMULATOR DEFECT: YES. The correction below explicitly resolves the prior expiry ambiguity; original classifications remain unchanged in v1.0.

## Corrected expiry semantics — symmetric V0/V1/V2/V3

A 1m candle has closeTime = openTime + 60000 ms (existing boundary convention). Entry eligibility remains openTime > original cutoff AND closeTime <= entryExpiry; entryExpiry = original cutoff + 12h.

- closeTime < entryExpiry: eligible.
- closeTime == entryExpiry: eligible.
- closeTime > entryExpiry: ineligible, including the minute containing a non-aligned expiry.

Only fully eligible, valid closed candles can establish entry. If the last eligible candle does not establish entry, continue only while another fully eligible candle exists. Once the set is exhausted with the order still waiting and required data valid: UNFILLED, model gross R=0, model net R=0, entry fee=0, exit fee=0. Do not inspect a partial expiry candle to infer whether entry happened before expiry. A partial minute alone is NOT DATA_UNAVAILABLE, AMBIGUOUS_ENTRY or UNRESOLVED_OPEN.

This does not override earlier invalidation, ambiguity, missing/invalid required data or established fills. Those rules remain frozen. Filled positions continue under the original 72h outcome horizon. No change to outcome-horizon partial-minute semantics, execution order, gap treatment or fees. No V1-specific exception.

## Unchanged strategy parameters

Exact archive/cohort and 91 tradeIds, cutoff, ATR, variants, geometry, fees, random-control parameters and PRNG are copied without alteration into JSON unchangedStrategyParameters. Only the expiry clarification, primary estimand and explicitly disclosed decision/reporting rules govern v1.1 in place of their v1.0 counterparts.

- E0=initialPlan.entryPrice; S0=initialPlan.initialStopLoss; d=+1 Long, -1 Short.
- V0: E0 / S0.
- V1: E0-d*0.25*abs(E0-S0) / S0.
- V2: E0; structural SL from last 12 fully closed 1H candles: Long min(low)-0.10*ATR, Short max(high)+0.10*ATR.
- V3: V1 entry / V2 stop; independent geometry validation retained.
- Core-style ATR14: mean(high-low) of last 14 contiguous fully closed source-aligned OKX 1D candles; no fallback, no research rounding.
- Research TP=variant Entry+d*1.075*ATR; 100% exit at research TP; original TP1 retained as diagnostic.
- R denominator=abs(model Entry-model Stop); no leverage multiplication.
- Entry expiry 12h; outcome horizon 72h from ORIGINAL cutoff; execution 1m; first eligible minute floor(cutoff/60000)*60000+60000.
- Fee 0.0005 per executed side on executed model notional; no discounts; funding excluded; no new slippage model.
- No changes to alpha, structural window/buffer, TP, ATR, horizon, cohort, mapping, seed or random control. No V4, filters, parameter search or alternative parameter sets.

## Primary estimand and attrition

Primary question: does frozen V1 improve model net R relative to V0 under corrected expiry?

Join the same frozen signals by tradeId. Include a signal if BOTH V0 and V1 have finite numeric model net R. No V2/V3 eligibility requirement, sign test or profitability selection. UNFILLED=0R is numeric and remains included. Genuine unknowns (DATA_UNAVAILABLE, AMBIGUOUS, AMBIGUOUS_ENTRY, UNRESOLVED_OPEN, GEOMETRY_UNAVAILABLE, ATR_UNAVAILABLE, STRUCTURE_UNAVAILABLE and any other unknown netR) remain nonnumeric; never substitute zero.

Primary effect = mean(V1.netR-V0.netR) on that paired set. Report paired N, excluded N, mean and median paired differences, and 95% day-cluster bootstrap CI for the mean. An unavailable estimate/CI is INVALID / NOT INTERPRETABLE, not fabricated.

Report V0/V1 Original N, Numeric N, TP, STOP, UNFILLED, INVALIDATED_UNFILLED, AMBIGUOUS, AMBIGUOUS_ENTRY, DATA_UNAVAILABLE, UNRESOLVED_OPEN, all other nonnumeric states, confirmed fill count and percent. Report the complete 2x2 numeric/nonnumeric availability matrix, V1_V0_PAIR_AVAILABLE_N, and reconcile to 91. Discuss remaining asymmetric attrition explicitly; mechanical pairing can still be informative censoring.

V2/V3 remain secondary and receive the identical expiry correction. Retain the original all-four resolved intersection for secondary comparisons, clearly separate from the new primary denominator. Preserve policy-separated reporting. Do not select a variant or parameters using subgroups.

## Bootstrap and decision rule — frozen before corrected execution

UTC origin.detectedAt calendar-day clusters; 10000 repetitions; seed 20261015; LCG32 as v1.0; Type 7 percentiles 2.5%/97.5%. Sample D days with replacement, retaining whole clusters (and repeating entire clusters on repeated draws). Use the SAME sampled days for V0/V1. Calculate pooled per-trade paired differences, not equal-weight daily means. Preserve original deterministic ordering/reset rules, including separate policy reporting. No seed or method changes after results.

Priority order:
1. Material simulator/data integrity problem or unavailable primary estimate/CI: INVALID / NOT INTERPRETABLE, overriding all other labels.
2. IMPROVED: mean paired Net difference >0 AND CI lower >0.
3. NOT IMPROVED: mean paired Net difference <=0 OR CI upper <=0.
4. INCONCLUSIVE: mean paired difference >0 and CI includes zero, unless a preceding rule applies.

This ordering resolves the upper-bound-equals-zero overlap in favor of NOT IMPROVED. No alternative threshold may be chosen after seeing results.

## Random control — static determination

Affected by this expiry defect: NO, based on reading random-control.mjs, not execution. prepare() admits scheduled times only when t+MINUTE<=expiry (and horizon). execute() enters immediately at selected.open; it has no waiting-limit expiry branch. It calls buildPlans() and sampleControlTimes(), not simulator.simulate(). Thus the affected simulate() PARTIAL_EXPIRY_MINUTE path is not used.

Preserve original results; no rerun required and no change for superficial symmetry. If later inspection demonstrates the same defect in random control: STOP before corrected historical execution and report it; do not silently modify semantics.

Previously reported values (copied, not recalculated): 91 eligible signals; 9100 expected and retained samples; 7509 resolved numeric; TP 3271; STOP 4238; UNRESOLVED_OPEN 1591; mean Gross resolved -0.058156; mean Net resolved -0.089481. No new random-control design.

## Required future regression gate

Before any separately authorized corrected execution, synthetic tests must prove:
A. closeTime==expiry is eligible.
B. expiry inside candle makes that candle ineligible.
C. Entry touch on final eligible candle fills, subject to unchanged ambiguity rules.
D. Touch only on partial expiry candle gives UNFILLED for an otherwise valid still-waiting path.
E. No eligible touch gives UNFILLED, unless an earlier frozen invalidation/ambiguity/data rule applies.
F. UNFILLED gross/net R=0 and no fees.
G. Genuine missing/invalid required data remains DATA_UNAVAILABLE.
H. Outcomes not logically affected by expiry correction remain identical to v1.0.

After the future corrected run, list EVERY changed historical tradeId/classification. Any historical change unrelated to expiry correction: STOP, INVESTIGATE, DO NOT INTERPRET PERFORMANCE. No regression execution is authorized in this documentation phase.

## Preservation, interpretation and authorization

Never overwrite /Users/polusmak/analysis/validation/entry-stop-v1-results/.
Future v1.1 outputs must use /Users/polusmak/analysis/validation/entry-stop-v1.1-results/ with no overwrite. Preserve the first manifest, reports, raw results and forensics permanently.

Even IMPROVED means CORE CHANGE JUSTIFIED: NO; REAL-MONEY ACTIVATION JUSTIFIED: NO. The archive is historical, completion-selected, small, time-concentrated, strongly directionally imbalanced and already inspected during development. A positive corrected result only justifies considering V1 as a frozen candidate for prospective validation on NEW signals; it does not validate live-money trading.

This phase creates only this Markdown and its machine-readable JSON companion. No simulator edits, historical runs, result recalculation, parameter search, new variants, Core change, network requests, commit, push or deploy.

CORE: FROZEN
REAL-MONEY: HOLD
FORWARD: PAUSED
STOP BEFORE COMMIT.
