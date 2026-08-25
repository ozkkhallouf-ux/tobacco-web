# PHASE 8 — REVIEW OTHER SCRIPTS (تصنيف فقط، بدون أي تعديل/تشغيل/اختبار)

> منهجية: `Get-ScheduledTask`/`Get-ScheduledTaskInfo` (قراءة فقط) لكل المهام غير Microsoft،
> ومطابقة `Actions.Arguments` وملفات `.vbs` تحت `TaskWrappers\` باسم كل سكريبت `.ps1` فعلي.
> لم يُعدَّل أو يُشغَّل أو يُختبر أي سكريبت مذكور هنا ضد Production.

## ACTIVE SCHEDULED (مهمة مسجّلة وغير Disabled الآن، مؤكدة من Task Scheduler الحي)

| Script | Task | Cadence (Triggers) | LastResult | ملاحظة خطر hang مشابه؟ |
|---|---|---|---|---|
| `push-purchase-item-snapshot.ps1 -Apply` | TOBACCO Ameen Item Snapshot Refresh | يومي | 0 | **يكتب للأمين (`-Apply`)** — يتعارض مع الذاكرة `ameen-readonly-default-policy.md` التي تذكر أنه تحوّل لـSupabase-only. تناقض يستحق تحقق منفصل، لم يُلمس هنا. |
| `ameen-sync-agent.ps1` | TOBACCO Ameen Sync | متكرر (دقيقة) | 267009 (Running) | نفس نمط `Running`/`267009` — لا نعرف إن كان طبيعي أو stuck بدون heartbeat مماثل. خطر محتمل، خارج نطاق Phase 1. |
| `sync-ameen-warehouse-reports.ps1` | TOBACCO Ameen Warehouse Reports | يومي | 0 | لا مؤشر hang حالياً. |
| `sync-approved-prices-to-ameen.ps1 -Apply` | TOBACCO Approved Prices Pull | كل 5 دقائق | 0 | **اسم المهمة "Pull" لكنها فعلياً تشغّل سكريبت "Apply" كاتب للأمين** — عدم تطابق تسمية/سلوك يستحق تنويه؛ لم يُلمس. |
| `push-customer-invoices.ps1` | TOBACCO Customer Invoices Push | — | 0 | **المهمة معطّلة (Disabled) حالياً** رغم وجود السكريبت والـregister script. |
| `push-invoice-series.ps1` | TOBACCO Invoice Series Push | متكرر | 0 | لا مؤشر hang. |
| `push-item-details.ps1` | TOBACCO Item Details Push | متكرر | 0 | لا مؤشر hang. |
| `pull-purchase-invoices-from-ameen.ps1` | TOBACCO Purchase Invoices Pull | متكرر | 0 | يقرأ الأمين فقط (readonly display per commit سابق)؛ لا مؤشر hang. |
| `push-sales-line-items.ps1` | TOBACCO Sales Line Items Push | متكرر | 0 | لا مؤشر hang. |
| `ameen-read-gateway.ps1` | (تبعية) TOBACCO Ameen Read Worker | يُستدعى من داخل `ameen-read-worker.ps1` وليس Task منفصل | — | خارج Phase 1 نطاق التعديل، لكنه ضمن مسار العامل الذي عولج بالفعل. |

**السطر 3 والفريدة (خارج النطاق المعتمد لـPhase 1، معالجَة فعلياً):**
`ameen-read-worker.ps1` (TOBACCO Ameen Read Worker), `ensure-ameen-sync.ps1` (TOBACCO Sync Watchdog), `push-customer-movements.ps1` (TOBACCO Customer Movements Push, `LastResult=1` — فشل ملاحَظ **بدون تحقيق**، غير ذي صلة بتعديلات Phase 1 لأن التعديل لم يُشغَّل بعد ضد Production).

**ليست سكريبتات `.ps1` متتبَّعة أصلاً (ملاحظة توثيقية فقط):**
- `TOBACCO Daily Git Pull` يشغّل `C:\ProgramData\OZK-TOBACCO\TaskWrappers\tobacco-daily-git-pull-launcher.ps1` — **ملف منشور خارج Git tracking**، ليس نفس `tools/daily-git-pull.ps1` المتتبَّع.
- `TOBACCO Ameen Backup Pull` يشغّل `C:\ProgramData\OZK-TOBACCO\LocalBackup\pull-local-ameen-backup.ps1` — أيضاً **خارج Git tracking**، ليس `tools/pull-ameen-backup.ps1`.
- `TOBACCO Local Web Server` يشغّل `node.exe` مباشرة على `C:\ProgramData\OZK-TOBACCO\LocalWebServer\server.mjs` — ليس PowerShell أصلاً.

> هذه الثلاثة نسخ منشورة (deployed) منفصلة عن نسخ Git المتتبَّعة بنفس الاسم أو اسم مشابه —
> فارق موثَّق فقط، لم يُحسَم أيّما "الصحيح"، ولم يُعدَّل أي منها.

## MANUAL ONLY (أدوات تشغَّل يدوياً، لا Task مجدولة تستدعيها)

`check-accountant-ameen.ps1`, `check-ameen-balances.ps1`, `check-ameen-balances-2.ps1`,
`verify-all.ps1`, `verify-balances-all.ps1`, `verify-customer-invoice-sync.ps1`,
`verify-payments.ps1`, `verify-prices.ps1`, `install-order-fix.ps1`, `install-stock-fix.ps1`,
`setup-ameen-retail-pricelist.ps1`, `setup-ameen-sync-env.ps1`, `setup-shared-sql.ps1`,
`set-ameen-write-connection.ps1`, `set-sync-password.ps1`, `start-claude-code.ps1`,
`ai-work-coordination.ps1`, `convert-task-to-service-account.ps1`, `ameen-daily-summary.ps1`,
`export-unit-factors.ps1`, `pull-item-numbers.ps1`, `serve-update-file.ps1`,
جميع سكريبتات `register-*-task.ps1` و`register-*watchdog.ps1` (21 ملفاً) — أدوات تسجيل مهام
تُشغَّل مرة واحدة من العامل، ليست هي نفسها مهاماً مجدولة.
`send-telegram-notification.ps1` — مكتبة مساعدة تُستدعى من سكريبتات أخرى، ليست مجدولة بذاتها.

## RETIRED (على الأرجح — تشخيص/استكشاف لمرة واحدة، بلا Task ولا استدعاء ظاهر)

كل ملفات `discover-*.ps1` (23 ملفاً: `discover-500`, `discover-all`,
`discover-ameen-bill-types`, `discover-ameen-bill-unit-column`,
`discover-ameen-bill-unit-column-2`, `discover-ameen-expense-accounts`,
`discover-ameen-expense-payments`, `discover-ameen-inventory-recon-fields`,
`discover-ameen-pricelists`, `discover-ameen-pricelists-2`, `discover-ameen-pricelists-3`,
`discover-ameen-purchase-schema`, `discover-ameen-sales-2/3/4`,
`discover-ameen-sales-schema`, `discover-ameen-shamcash-fund`, `discover-ameen-suppliers`,
`discover-currency`, `discover-en-order`, `discover-entry-order`,
`discover-item-stock` + `-2/-3/-4`, `discover-order-limit`, `discover-stock-items`,
`discover-syp-expenses`) — أسماؤها وأرقام النسخ اللاحقة (`-2`, `-3`, `-4`) تدل على استكشاف
بنية قاعدة الأمين لمرة واحدة أثناء تطوير ميزة، ولا يوجد أي Task مجدولة تستدعيها. **افتراض
وليس يقيناً — لم يُشغَّل أي منها للتحقق.**

## UNKNOWN (بحاجة تحقق بشري — لم يُحسَم التصنيف من الأدلة المتاحة)

هذه الملفات تحمل أسماء `push-*`/`sync-*`/`apply-*` (أي **كاتبة/محتملة الكتابة للأمين أو
Supabase**) لكن لا Task مجدولة نشطة تستدعيها ضمن القائمة الحية المفحوصة، ولا تحقّقت من
كونها Retired أو أنها تُستدعى يدوياً أو من سكريبت آخر لم أتتبعه بعمق. **لم تُشغَّل ولم
تُختبر ولم تُعدَّل أي منها إطلاقاً، التزاماً صارماً بشرط Phase 8:**

`apply-approved-prices-to-ameen.ps1`, `archive-documents.ps1`, `auto-sync-price-lists.ps1`,
`daily-git-pull.ps1` (نسخة متتبَّعة، لكن الـTask الحية تستخدم نسخة أخرى خارج Git — انظر أعلاه)،
`ensure-local-server.ps1`, `publish-price-sync-status.ps1`,
`pull-ameen-backup.ps1` (نفس ملاحظة daily-git-pull)، `pull-approved-prices.ps1`
(**تناقض مع توثيق CLAUDE.md** الذي يصفه كخطوة سحب منفصلة كل 5 دقائق — الـTask الحية الفعلية
باسم "Approved Prices Pull" تستدعي `sync-approved-prices-to-ameen.ps1 -Apply` وليس هذا
الملف؛ لم يتحقق أين/هل يُستدعى `pull-approved-prices.ps1` أصلاً)،
`push-ameen-account-balances.ps1`, `push-ameen-warehouse-stock.ps1`,
`push-ameen-warehouse-transfers.ps1`, `push-customer-currency.ps1`,
`push-daily-expenses.ps1`, `push-daily-movement.ps1`, `push-daily-profit.ps1`,
`push-daily-reports.ps1`, `push-docs-to-drive.ps1`, `push-expense-entries.ps1`
(له `register-expense-entries-task.ps1` لكن لا Task فعلية مسجّلة حالياً)،
`push-inventory-reconciliation-to-ameen.ps1`, `push-item-costs.ps1`,
`push-supplier-obligations.ps1`, `sync-purchase-invoices-to-ameen.ps1`,
`upload-report-to-supabase.ps1`.

> **تنبيه صريح مطلوب من المستخدم بالمواصفة:** كل هذه الأسماء الكاتبة (write-oriented) لم
> تُلمس، لم تُشغَّل، ولم تُختبر ضد Production — التصنيف هنا اعتماداً على الاسم وغياب Task
> حية مطابقة فقط، وليس فحصاً لمحتوى الكود نفسه.

## خلاصة العدّ

- إجمالي `tools/*.ps1`: 106
- Phase 1 (معالَجة فعلياً، خارج Phase 8): 3
- ACTIVE SCHEDULED مؤكدة (بما فيها التبعية `ameen-read-gateway.ps1`): 10
- MANUAL ONLY: 42
- RETIRED (افتراضي): 23
- UNKNOWN (كاتبة محتملة، غير محسومة): 25
- إجمالي المصنَّف: 103 (+ 3 Phase 1 = 106) ✓ مطابق

**هذا التقرير Phase 2 لاحقة كما حدد المستخدم — لا إجراء إضافي متوقع الآن.**
