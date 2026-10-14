# SM1M $0 Forward Validation Protocol v1.1

## 1. Status

- Protocol: SM1M $0 Forward Validation Protocol v1.1
- Status: FROZEN BUT NOT ACTIVATED
- Real-money activation: HOLD
- Core: FROZEN
- Forward activation timestamp: NOT SET
- First eligible signal: NOT SET
- Forward cohort: NOT STARTED
- Historical exploratory analysis: CLOSED

После активации v1.1 нельзя редактировать задним числом. Любое изменение правил требует новой версии протокола.

v1.0 was frozen but NEVER ACTIVATED.

v1.1 supersedes v1.0 BEFORE any Forward cohort started.

No observations may be retroactively assigned to either protocol.

Причина v1.1: до активации обнаружено несоответствие требования fresh A+ при входе фактической frozen Core semantics. Это исправление неактивированного protocol, не изменение trading strategy.

## 2. Purpose

Проверить на новых, ранее не наблюдавшихся сигналах качество canonical confirmed A+, достижение TP1, полный lifecycle, model resultR и устойчивость результата между разными signal-days.

Это $0 / model-only validation, без реальных денег, изменений Core и оптимизации по историческому архиву. Forward validation не является доказательством будущей прибыльности.

## 3. Cohort start

До активации зафиксировать exact backend Core commit SHA и exact UTC activation timestamp. В cohort входят только сигналы с `origin.detectedAt >= activation timestamp`. Сигналы до timestamp запрещено добавлять задним числом.

Записанный сейчас backend HEAD не является моментом начала cohort. Перед активацией Core SHA должен быть подтверждён.

Если после активации изменяется Core execution/trading logic, текущая cohort закрывается. Новая логика требует новой protocol version или нового explicitly separated cohort. Результаты разных Core versions не смешиваются; требования раздела 17 обязательны.

## 4. Signal universe

Все canonical confirmed A+ signals после activation timestamp. Сохранять каждый такой сигнал независимо от того, стал ли он simulated trade. Никаких субъективных исключений после появления результата.

## 5. Model execution rules

Forward должен максимально имитировать будущий real-money protocol. Model trade разрешён только если одновременно:

- setup прошёл полный canonical confirmed A+ gate при ORIGINAL SETUP CREATION;
- original eligibility evidence frozen;
- цена достигает original frozen Entry Zone;
- одновременно открыто < 3 model positions;
- после открытия будет не более 2 позиций одного направления;
- не более 1 позиции на один instrument;
- frozen SL и TP1 доступны;
- используется frozen original plan.

Model activation follows existing frozen lifecycle: valid frozen plan; valid time/expiry boundaries; required confirmed 1m candle evidence; frozen Entry Zone touched before expiry; existing lifecycle integrity requirements pass.

Later fresh Score / Grade / Recommendation / canonical A+ changes DO NOT cancel an existing frozen WaitingEntry setup. No fresh canonical A+ recheck is required at WaitingEntry → Active. Protocol MUST NOT add a new fresh-A+ entry filter.

Saved/Frozen Trade Plan и Fresh Live Analysis — разные слои. Fresh D / Wait после creation сам по себе не делает frozen setup invalid. Fresh analysis существует независимо и используется там, где frozen Core уже использует его, включая post-TP1 reanalysis.

После открытия не изменять frozen Entry Zone, initial SL и TP1. Предписанный frozen exit policy перевод current/model stop в break-even сохраняется; это не изменение initial SL.

Запрещены averaging, widening SL, discretionary early close и subjective trade selection.

## 6. TRADED / SKIPPED

Каждый forward A+ должен получить TRADED или SKIPPED. Причина SKIPPED сохраняется:

- MISSED ENTRY
- RISK/CAPACITY LIMIT
- UNAVAILABLE
- DATA/VERIFICATION FAILURE

Другую техническую причину сохранять явно, сигнал не удалять.

В полностью автоматическом $0 model forward человеческая доступность не участвует в simulation. UNAVAILABLE не используется как человеческий discretionary filter; техническая недоступность должна быть явно описана.

Operational tracking не объявляется реализованным. До activation требуется отдельный readiness audit: TRADED / SKIPPED tracking, skip reasons, max 3 simultaneous model positions, max 2 same direction, max 1 per instrument. Сейчас ничего из этого не реализуется.

## 7. Exit policy

Frozen current policy: `tp1-50-reanalyse-v1`.

После TP1: реализовать model 50%; remaining 50%; stop → model break-even согласно текущей frozen implementation; fresh SM1M reanalysis; HOLD или CLOSE; сохранить полный lifecycle.

Никаких изменений exit policy внутри cohort.

## 8. Performance cohorts

### A. ALL FORWARD A+

Все canonical confirmed A+ после activation timestamp. Показывать total signals, TRADED, SKIPPED и причины SKIPPED. Эти результаты нельзя скрывать.

### B. CLEAN MODEL-TRADED COHORT

Только сделки, которые по frozen operational rules действительно были бы открыты. Эта cohort используется для основного performance gate.

## 9. Primary sample requirement

Primary evaluation разрешена только при выполнении ОБОИХ условий:

- clean completed model trades >= 30;
- unique UTC signal-days >= 15.

Signal-day — исключительно UTC calendar date of `origin.detectedAt`. Не использовать completion day, activation day, exit day или local timezone. Для primary evaluation signal-days считаются среди clean completed model trades, используемых в performance metrics и bootstrap.

Если 30 trades достигнуты раньше 15 signal-days — продолжать. Если 15 signal-days достигнуты раньше 30 completed — продолжать.

## 10. Primary metrics

Для CLEAN MODEL-TRADED COHORT:

- completed n;
- unique UTC signal-days;
- cumulative model R;
- mean model R/trade;
- median model R;
- Profit Factor;
- lifecycle TP1 n и rate;
- full -1R count/rate;
- max drawdown R;
- maximum losing streak;
- Long / Short counts;
- trades per signal-day.

Performance metrics используют completed trades; unresolved trades не превращаются в completed results.

Все model R маркируются: **MODEL R — NOT EXCHANGE P&L.**

## 11. Day-cluster bootstrap

Primary uncertainty analysis:

- cluster = UTC signal-day from `origin.detectedAt`;
- 10,000 repetitions;
- seed = 20261012;
- sample D signal-days WITH REPLACEMENT, где D — число уникальных signal-days.

Каждый выбранный день переносится целиком со всеми clean completed model trades этого дня. Повторно выбранный день повторяет весь cluster. Число сделок в bootstrap sample может отличаться от исходного n.

Mean R = sum sampled resultR / number sampled trades.

TP1 rate = sampled lifecycle TP1 / number sampled trades.

Не использовать equally weighted daily means. Для Mean R/trade и TP1 rate показать bootstrap median, 2.5 percentile и 97.5 percentile.

Для воспроизводимости: deterministic 32-bit LCG, multiplier 1664525, increment 1013904223, modulo 2^32; RNG output = state / 2^32. Seed устанавливается в начале анализа cohort. Кластеры сортируются по UTC signal-day по возрастанию. Percentiles — linear interpolation, type 7. Альтернативные seeds/definitions после просмотра результатов не выбираются.

Это descriptive uncertainty, не statistical significance claim. Signal-days считаются независимыми clusters; зависимость соседних дней может сохраняться; малое число дней ограничивает надёжность bootstrap. Observational cohorts не рандомизированы; анализ не доказывает прибыльность или убыточность.

## 12. Pre-registered positive gate

Переход REAL-MONEY HOLD → LIMITED REAL-MONEY VALIDATION ELIGIBLE разрешён только если одновременно:

1. clean completed trades >= 30;
2. unique UTC signal-days >= 15;
3. cumulative model R > 0;
4. mean model R/trade > 0;
5. Profit Factor > 1.0;
6. lifecycle TP1 rate >= 45%;
7. day-cluster bootstrap 95% interval for Mean R is NOT entirely below 0;
8. concentration stress test PASS.

Passing gate НЕ доказывает прибыльность. Он только разрешает отдельное решение о начале ограниченной real-money validation. Он не активирует реальные сделки и не увеличивает риск автоматически.

## 13. Concentration stress test

До просмотра forward results фиксируется:

1. Сгруппировать clean completed model trades по UTC signal-day.
2. Рассчитать total resultR каждого дня.
3. Найти два signal-days с наибольшим ПОЛОЖИТЕЛЬНЫМ total resultR.
4. Удалить сделки этих двух дней только из расчётной stress-test выборки.
5. Пересчитать cumulative model R.

PASS только если remaining cumulative model R > 0.

Если положительных дней меньше двух — удалить все существующие положительные дни до максимума двух. При равенстве total resultR порядок детерминированный: UTC signal-day по возрастанию. Исходные записи не удаляются. Не выбирать дни после просмотра результата другим способом.

## 14. Early checkpoints

**10 clean completed:** measurement/execution sanity check ONLY. Не принимать решение о profitability.

**20 clean completed:** interim safety check. Если lifecycle TP1 <= 6/20 OR cumulative model R <= -7R, пометить:

**FORWARD WARNING / CONTINUE ONLY UNDER FROZEN RULES**

Это $0 model validation: Core автоматически не изменяется. Primary decision всё равно требует 30 completed + 15 signal-days, если нет обнаруженного P0/P1 measurement defect.

## 15. Failure / borderline result

Если primary sample достигнут, но хотя бы один positive gate FAIL, REAL-MONEY ACTIVATION remains HOLD. Не изменять Core автоматически; сначала создать отдельный forward review.

Если результат пограничный и нет P0/P1 defect, разрешено продолжить ТОТ ЖЕ frozen cohort до 50 clean completed trades без изменения thresholds или правил.

После просмотра первых 30 нельзя ослаблять gate, менять TP1 threshold, bootstrap, inclusion rules или выбирать новые filters.

## 16. P0/P1 defect rule

При реальном P0/P1 defect в измерении, lifecycle или integrity:

- остановить cohort;
- документировать defect;
- не смешивать повреждённые результаты с новой исправленной cohort;
- исправление Core требует нового cohort/version.

Bug fix не должен тихо продолжать старую cohort.

## 17. Immutability

После activation timestamp нельзя задним числом менять sample requirements, positive gate, TP1 threshold, bootstrap definition, seed, signal-day definition, inclusion/exclusion rules, concentration test, lifecycle policy или Core version.

Любое изменение требует: новая protocol version + effective timestamp + reason + новая cohort или явно разделённая cohort.

## 18. Historical context — NOT A TARGET

Historical exploratory analysis CLOSED.

| Historical metric | Legacy | New |
| --- | --- | --- |
| Completed | 69 | 22 |
| UTC signal-days | 13 | 7 |
| Mean R | -0.169942 | -0.571860 |
| Lifecycle TP1 | 31/69 = 44.927536% | 6/22 = 27.272727% |
| Day-cluster Mean R 95% interval | [-0.392382, 0.100084] | [-0.805474, -0.257348] |

Эти значения НЕ являются target для forward и НЕ используются для изменения gates. Исторический архив больше не используется для exploratory filter search.

## 19. SECONDARY OBSERVATIONAL ANALYSIS — ENTRY EXTENSION / ANTI-CHASE

Гипотеза: «Canonical A+ может возникать после уже состоявшегося сильного directional move, из-за чего entry происходит слишком близко к локальному экстремуму».

**THIS IS A HYPOTHESIS, NOT AN ESTABLISHED CAUSE.**

Diagnostics — observational only, recorded prospectively, defined before outcomes. Они не влияют на canonical A+, opportunityScore, recommendation, Entry Zone, lifecycle, SL/TP1 или HOLD/CLOSE; не входят в Positive Gate; не разрешают и не блокируют trades; не меняют Core во время cohort.

Historical archive remains CLOSED. Не рассчитывать эти diagnostics retrospectively из historical outcomes для filter search.

## 20. Timestamps / provenance

Сохранять BOTH `analysisAt` и `signalDetectedAt / origin.detectedAt`; не считать их молча идентичными. Также сохранять, где доступны: `priceTimestamp`, `dailyLastConfirmedAt`, `recordedAt`.

Canonical market-data cutoff: `metricCutoffAt = min(analysisAt, priceTimestamp)`, когда BOTH timestamps valid (минимум по времени).

Если analysisAt или priceTimestamp missing/invalid, метрики B, C, D, требующие external 1H candle reconstruction: `NULL + CUTOFF_UNAVAILABLE`. Запрещён fallback к signalDetectedAt, recordedAt, current time или later analysis time.

`recordedAt` = physical telemetry persistence time only. `recordedAt` MUST NEVER participate in market-data cutoff or metric calculation.

Для B/C/D все eligible 1H candles должны удовлетворять `candle.closeTime <= metricCutoffAt`.

Market-data cutoff фиксируется как `metricCutoffAt`. Использовать только информацию, объективно доступную at or before metricCutoffAt. No future candle data. `recordedAt` никогда не представляется как `eventAt`. Activation-time metric нельзя восстановить из later fresh analysis и представить как известную при activation.

## 21. Metric A — EMA20 EXTENSION

Использовать existing Core definition:

- d = +1 Long, -1 Short;
- P = original signal/origin price;
- EMA20 = signal-time Core EMA20;
- ATR = signal-time Core ATR14.

`ema20Extension = d × (P - EMA20) / ATR`

Core ATR: mean(high - low) последних 14 confirmed daily candles, использованных Core. Это НЕ standard True Range ATR.

Invalid/missing inputs: NULL + explicit reason, никогда не zero substitute. No threshold; не определять «ema20Extension > X = bad trade».

## 22. Metric B — CLOSED-1H 24H RANGE POSITION

Не использовать ambiguous provider ticker 24h range.

Использовать последние 24 fully closed 1H candles с `candle.closeTime <= metricCutoffAt`.

`high24 = maximum high of those 24 candles`

`low24 = minimum low of those 24 candles`

`P = original signal price`

`raw = (P - low24) / (high24 - low24)`

LONG: `range24hDirectional = raw`

SHORT: `range24hDirectional = 1 - raw`

Требования: exactly 24 eligible fully closed 1H candles; high24 > low24; no candle after metricCutoffAt; preserve first/last candle timestamps и data source/provenance.

Если P вне [low24, high24], не clamp silently: сохранить raw value и explicit reason/flag price/range inconsistency. Если required candles unavailable: NULL + reason. No threshold.

## 23. Metric C — PRE-SIGNAL 4H DIRECTIONAL MOVE / CORE ATR

Это metric C в v1.1 (исходный research candidate D). Использовать fully closed 1H candles only.

`reference4h = close of the latest fully closed 1H candle with candle.closeTime <= metricCutoffAt - 4 hours`

P = original signal price.

LONG: `move4hAtr = (P - reference4h) / CoreATR`

SHORT: `move4hAtr = (reference4h - P) / CoreATR`

Сохранить reference candle timestamp, reference price, metricCutoffAt, ATR, source/provenance. Если нет valid reference: NULL + reason. No interpolation. No future candle. No threshold.

## 24. Metric D — PRE-SIGNAL 24H DIRECTIONAL MOVE / CORE ATR

Использовать fully closed 1H candles only.

`reference24h = close of the latest fully closed 1H candle with candle.closeTime <= metricCutoffAt - 24 hours`

P = original signal price.

LONG: `move24hAtr = (P - reference24h) / CoreATR`

SHORT: `move24hAtr = (reference24h - P) / CoreATR`

Те же provenance/null rules, что для 4H: reference timestamp/price, metricCutoffAt, ATR, source; no valid reference → NULL + reason. No interpolation, future candle или threshold.

## 25. Context metric — CORE ATR %

`coreAtrPct = CoreATR / P × 100`

Contextual volatility descriptor only. Это НЕ Anti-Chase gate. No threshold. Невалидные/отсутствующие числовые inputs не заменяются нулями: NULL + reason.

## 26. Secondary analysis plan

На predefined Forward review для каждой метрики можно показать:

- n available / n unavailable;
- missing reason counts;
- overall distribution;
- TP1-before-stop distribution;
- STOP-before-TP1 distribution;
- descriptive median/mean;
- individual trade table.

Optional descriptive tertiles разрешены ONLY если boundaries вычислены механически из achieved Forward sample, все группы показаны, n / TP1 rate / mean model R показаны, tertiles явно exploratory/descriptive и не превращаются в entry thresholds из той же cohort.

Запрещены optimization, threshold search, classifier training, ROC selection, best cutoff search, изменение Positive Gate и strategy change from same sample.

Первая cohort может породить гипотезу для отдельно preregistered future Entry experiment.

## 27. Sample size interpretation

30 completed + 15 signal-days — PRIMARY Forward performance checkpoint. От него НЕ ожидается strong statistical evidence для Anti-Chase subgroup effects.

Small subgroup counts маркировать insufficient/descriptive. Отсутствие видимого разделения не означает absence of effect.

## 28. External / isolated collection

Anti-Chase metrics могут собираться isolated research/telemetry process вне Core trading decisions. Этот слой может prospectively использовать public market data после записи сигнала, восстанавливая ONLY candles, уже fully closed by stored cutoff.

Retrieving historical candles later разрешено ONLY для реконструкции информации, существовавшей by cutoff. No candles/data after cutoff may enter metric calculation. Это не разрешение historical outcome/filter search.

Telemetry failure MUST NOT affect trading lifecycle. Core trading functions MUST NOT read Anti-Chase telemetry. Сейчас collector не реализуется и не запускается.

## 29. Activation record

- Protocol version: v1.1
- Protocol frozen at: 2026-10-14T09:39:58Z
- Supersedes: v1.0 — NEVER ACTIVATED
- Core SHA (current protocol repository HEAD): a74c5d45f7ca3e00d4ad4c60a81f0624f444303c
- Anti-Chase definition version: anti-chase-v1
- Forward activation timestamp: NOT SET
- First eligible signal: NOT SET
- Status: FROZEN BUT NOT ACTIVATED
- REAL-MONEY: HOLD

Protocol frozen at — время создания документа UTC, НЕ activation timestamp. Core SHA прочитан из текущего backend HEAD; его фиксация не запускает cohort. Protocol repository HEAD может включать documentation-only commits: он отличен по смыслу от frozen trading/execution semantics. Documentation commit не меняет trading behavior; перед activation подтверждается фактический Core SHA.

## 30. Strict execution scope

Сейчас DOCUMENTATION ONLY. Создаётся только этот protocol markdown. Протокол описывает будущие требования, но не утверждает, что operational tracking/capacity enforcement уже реализованы или активированы.

Не изменять v1.0, Core, market.js, tests, frontend, research runner, historical reports или unrelated local files. Не выполнять historical outcome analysis, не реализовывать telemetry и не запускать collector. Не выполнять production/Redis/provider/API requests, deploy, commit или push. Не устанавливать activation timestamp и не начинать cohort.

FORWARD COHORT: NOT STARTED

ACTIVATION TIMESTAMP: NOT SET

REAL-MONEY ACTIVATION: HOLD

CORE: FROZEN
