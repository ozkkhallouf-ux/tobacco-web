# مرجع تصميم إيصال الكاشير 80mm الحي

`OzkReceiptRenderer.live-f7806b56.psm1`: نسخة **بالبايت** من الرسّام العامل على OZKUSER
(sha256 `f7806b562637e3c1e4b825e6dc4906c71f481a26eeffc2753f3fac81053f1aee`). سُحبت للقراءة فقط
في 2026-11-12، وهي نفسها blob ‏`c7a8ee28:tools/cashier-reprint/static-bridge/ozk-print-bridge/OzkReceiptRenderer.psm1`.

**لا يُعدَّل هذا الملف ولا يُحمَّل في الإنتاج.** هو مرجع اختبار التطابق البصري
`tools/tests/Test-CashierReceiptVisualMatch.ps1`. أي رسّام مرشّح لترقية جسر OZKUSER يجب أن يطابقه بكسلاً
بكسلاً، وأن تطابق بايتات ESC/POS المرسلة للطابعة، على مجموعة إيصالات وهمية ثابتة قبل أي نشر.
