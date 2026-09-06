// ============================================================================
// قائمة الفحوص التي تشكّل بوابة `npm run check` — مصدر الحقيقة الوحيد.
//
// لماذا وُجد هذا الملف: كانت السلسلة سطراً واحداً بطول 1736 حرفاً في
// package.json يربط 34 عامل «&&». فكل PR يضيف فحصاً يحرّر السطر نفسه، فيتصادم
// مع كل PR آخر. وقع ذلك ثلاث مرات متتالية خلال ساعتين على PR #158 وحده (تحرّك
// main عبر #155 ثم #156)، ومرة قبلها على #154. والأسوأ أن التعارض يمنع
// تشغيل `check` و`validate` أصلاً — GitHub لا يحسب merge-ref لفرع متعارض —
// فتصادم سطر واحد يُسكت إشارة CI كلها.
//
// الترتيب: check.mjs أولاً دائماً (يتحقق من وجود الملفات المطلوبة، ففشله
// المبكر أرخص)، ثم البقية أبجدياً. الأبجدية مقصودة: تجعل الإضافات تقع في
// مواضع متفرقة فيندمجها git تلقائياً. وهي لا تُلغي التعارض تماماً — لو أضاف
// PRان اسمين متجاورين لظلّ ممكناً — لكنها تُنزله من «حتمي» إلى «نادر». هذا
// وصف الهدف بدقة، ولا نَعِد git بسحر لا يملكه.
//
// أُثبت أمان تغيير الترتيب قبل اعتماده (2026-08-31): شُغّلت الـ37 بالترتيب
// القديم ثم بالأبجدي على نفس الشجرة بعد npm ci، والنتيجة 37/37 نجاح في
// الحالتين — فلا اعتماد خفي بين الفحوص.
// ============================================================================
export const CHECKS = [
  // يبقى الأول دائماً — يفرضه scripts/check-checks-manifest.mjs
  'check.mjs',
  'check-alert-on-automation-failure.mjs',
  'check-ameen-read-gateway.mjs',
  'check-ameen-read-worker-registration.mjs',
  'check-assistant-authorization.mjs',
  'check-assistant-read-only.mjs',
  'check-assistant-routing.mjs',
  'check-checks-manifest.mjs',
  'check-codex-review-gate-logic.mjs',
  'check-collection-priority.mjs',
  'check-command-center.mjs',
  'check-credit-limit-identity.mjs',
  'check-cron-job-health-classifier.mjs',
  'check-customer-invoice-identity.mjs',
  'check-docker-dev-port-binding.mjs',
  'check-document-filenames.mjs',
  'check-error-monitoring.mjs',
  'check-expense-entries-pipeline.mjs',
  'check-expense-entries-security.mjs',
  'check-health-check-logic.mjs',
  'check-icloud-archive-console-silence.mjs',
  'check-inventory-recon-cost-fallbacks.mjs',
  'check-inventory-report-page-packing.mjs',
  'check-inventory-report-print-pages.mjs',
  'check-invoice-document-integrity.mjs',
  'check-item-cost-matching.mjs',
  'check-item-guid-migrations.mjs',
  'check-item-guid-preservation.mjs',
  'check-item-snapshot-freshness.mjs',
  'check-item-snapshot-generation-race.mjs',
  'check-item-snapshot-pipeline.mjs',
  'check-item-snapshot-registration.mjs',
  'check-item-snapshot-security.mjs',
  'check-keyboard-shortcut-routes.mjs',
  'check-local-site-server.mjs',
  'check-mac-archive-bridge.mjs',
  'check-master-item-coverage-dedup.mjs',
  'check-owner-authorization-behavior.mjs',
  'check-post-deploy-smoke-console-gate.mjs',
  'check-price-bulletin-export-integrity.mjs',
  'check-price-bulletin-first-page-content.mjs',
  'check-price-bulletin-group-packing.mjs',
  'check-price-bulletin-group-placement.mjs',
  'check-price-bulletin-item-coverage.mjs',
  'check-price-bulletin-layout.mjs',
  'check-price-bulletin-print-content.mjs',
  'check-price-bulletin-print-ux.mjs',
  'check-project-task-monitors.mjs',
  'check-purchase-recommendation.mjs',
  'check-push-expense-entries-dryrun-safety.mjs',
  'check-sales-invoice-print-grace.mjs',
  'check-sales-line-items-pipeline.mjs',
  'check-sales-line-items-registration.mjs',
  'check-sales-line-items-security.mjs',
  'check-service-worker-update-cycle.mjs',
  'check-smart-inventory.mjs',
  'check-telegram-delivery-observability.mjs',
];

// ----------------------------------------------------------------------------
// فحوص موجودة على القرص وخارج هذه البوابة عمداً. كل استثناء يحتاج سبباً.
// يفرض الحارس أن كل ملف check*.mjs إمّا هنا أو في CHECKS — فلا يتكرر عطل
// «فحص موجود ولا يعمل ولا أحد يدري».
// ----------------------------------------------------------------------------
export const EXCLUDED = {
  'check-business-metrics.mjs':  'يعمل في .github/workflows/business-os-foundation.yml',
  'check-business-snapshot.mjs': 'يعمل في .github/workflows/business-os-foundation.yml',
  // طبقة المسارات الحرجة تشغّل متصفحاً عبر عشرات الصفحات؛ والبوابة تعمل ثلاث
  // مرات على كل PR (check.yml وdecision-engine-check.yml وpages.yml). لها
  // وظيفة مستقلة `critical-journeys` في check.yml، فتُشغَّل مرة واحدة وتُرفع
  // آثارها عند الفشل. تشغيلها يدوياً: npm run check:critical
  'check-critical-journeys.mjs': 'يعمل في وظيفة critical-journeys داخل .github/workflows/check.yml',
  'check-executive-team.mjs':    'يعمل في .github/workflows/business-os-foundation.yml',
};
