# مرجع تصميم إيصال الكاشير 80mm الحي

`OzkReceiptRenderer.live-f7806b56.psm1`: نسخة **بالبايت** من الرسّام العامل على OZKUSER
(sha256 `f7806b562637e3c1e4b825e6dc4906c71f481a26eeffc2753f3fac81053f1aee`). سُحبت للقراءة فقط
في 2026-11-12، وهي نفسها blob ‏`c7a8ee28:tools/cashier-reprint/static-bridge/ozk-print-bridge/OzkReceiptRenderer.psm1`.

**لا يُعدَّل هذا الملف ولا يُحمَّل في الإنتاج.** هو مرجع اختبار التطابق البصري
`tools/tests/Test-CashierReceiptVisualMatch.ps1`. أي رسّام مرشّح لترقية جسر OZKUSER يجب أن يطابقه بكسلاً
بكسلاً، وأن تطابق بايتات ESC/POS المرسلة للطابعة، على مجموعة إيصالات وهمية ثابتة قبل أي نشر.

`OzkReceiptRenderer.reprint-b2865472.psm1`: نسخة **بالبايت** من رسّام أداة إعادة الطباعة على `main`
بعد #441 و#442 (`tools/cashier-reprint/static-bridge/…`، sha256
`b2865472b19f747d9f811733b0072a3af324af5dd393d2becc3ed5c05ff50d11`). مرجع اختبار
`tools/tests/Test-CashierReprintDriverTransport.ps1`: إضافة مسار الطباعة عبر التعريف يجب ألا تغيّر أي سطر
آخر، ومسار RAW يبقى كما هو حرفياً.
