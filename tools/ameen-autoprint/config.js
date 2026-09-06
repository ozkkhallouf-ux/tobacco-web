"use strict";
// =============================================================
// config.js — عدّل هذا الملف قبل أول تشغيل
// =============================================================

module.exports = {
  // سلسلة اتصال SQL Server (نفس المتغير المستخدم في باقي سكريبتات الأمين)
  // مثال Windows Auth: "Server=.\\SQLEXPRESS;Database=AmnDb002;Trusted_Connection=true;"
  // مثال SQL Auth:     "Server=localhost;Database=AmnDb002;User Id=sa;Password=كلمة_المرور;"
  sqlConnectionString: process.env.AMEEN_SQL_CONNECTION_STRING || "",

  // ─── نوع فاتورة المبيعات المراد طباعتها ──────────────────────────────────
  // فقط "مبيعات" (الجملة النشيطة) — GUID مؤكّد من discover-ameen-sales-4.ps1
  // مبيعات المركز: تطبعها طابعة الكاشير — لا نتدخل فيها
  // مبيعات ل.س:   نوع قديم غير مستخدم — لا حاجة لطباعتها
  wholesaleTypeGuid: "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4",

  // ─── الطابعة ──────────────────────────────────────────────────────────────
  // اسم الطابعة كما يظهر في Windows: لوحة التحكم → أجهزة وطابعات
  printerName: "Canon G3410 WiFi",

  // ─── مسار SumatraPDF (للطباعة الصامتة — موصى به) ────────────────────────
  // ضع SumatraPDF.exe في مجلد bin/ بجانب هذا الملف
  // حمّله من: sumatrapdfreader.org/free-pdf-reader
  sumatraPath: require("path").join(__dirname, "bin", "SumatraPDF.exe"),

  // الفاصل الزمني بين كل استعلام وآخر (بالمللي ثانية)
  pollIntervalMs: 5000,

  // مسار ملف الحالة (يحفظ GUIDs الفواتير المطبوعة)
  stateFilePath: require("path").join(__dirname, "last-printed.json"),

  // مجلد الملفات المؤقتة
  tempDir: require("os").tmpdir(),
};
