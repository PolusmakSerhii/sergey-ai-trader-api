# SM1M $0 Forward Validation Protocol v1.0

## 1. Status

- Protocol: SM1M $0 Forward Validation Protocol v1.0
- Status: FROZEN BUT NOT ACTIVATED
- Real-money activation: HOLD
- Core: FROZEN
- Forward start timestamp: NOT SET
- Forward cohort: NOT STARTED
- Historical exploratory analysis: CLOSED

После активации v1.0 нельзя редактировать задним числом. Любое изменение правил требует новой версии протокола.

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

- canonical confirmed A+ остаётся валиден;
- цена достигает original frozen Entry Zone;
- одновременно открыто < 3 model positions;
- после открытия будет не более 2 позиций одного направления;
- не более 1 позиции на один instrument;
- frozen SL и TP1 доступны;
- используется frozen original plan.

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

## 19. Activation record

- Protocol version: v1.0
- Protocol frozen at: 2026-10-12T15:56:34Z
- Core SHA: 09e6b113e5209dd37e3b8ba037d23a840765336b
- Forward activation timestamp: NOT SET
- First eligible signal: NOT SET
- Status: FROZEN BUT NOT ACTIVATED
- REAL-MONEY: HOLD

Protocol frozen at — время создания документа UTC, НЕ activation timestamp. Core SHA прочитан из текущего backend HEAD; его фиксация не запускает cohort.

## 20. Strict execution scope

Сейчас DOCUMENTATION ONLY. Создаётся только этот protocol markdown. Протокол описывает будущие требования, но не утверждает, что operational tracking/capacity enforcement уже реализованы или активированы.

Не изменять Core, historical reports или unrelated local files. Не выполнять production/Redis/provider/API requests, deploy, commit или push. Не устанавливать activation timestamp и не начинать cohort.

FORWARD COHORT: NOT STARTED

ACTIVATION TIMESTAMP: NOT SET

REAL-MONEY ACTIVATION: HOLD

CORE: FROZEN
