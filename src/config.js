window.appConfig = {
  name: "OZK TOBACCO",
  supportEmail: "ozk.kh@outlook.com",
  centerNumber: "0994092038",
  privateNumber: "0985000771",
  tagline: "",
  description:
    "لوحة ويب عربية لإدارة طلبات العملاء، متابعة العمل عن بعد، مراقبة الحالة، وتجهيز الدفع الإلكتروني عند اختيار مزود مناسب.",
  language: "ar",
  paymentStatus: "واجهة جاهزة للربط",
  // أرشفة المستندات: شارة iCloud مخفية (الكود باقٍ للتراجع)، وشارة Google Drive تُفعَّل
  // بعد تطبيق الهجرة 22 وتشغيل العامل على OZK2026 بموافقة المالك.
  documentArchive: {
    icloudUi: false,
    driveUi: false
  },
  staffRoles: {
    "ozk.kh@outlook.com": { name: "موظف OZK", role: "موظف", accessRole: "employee" },
    "ozkkhalouf@gmail.com": { name: "مالك OZK", role: "المالك", accessRole: "owner" },
    "ozkkhallouf@gmail.com": { name: "مالك OZK", role: "المالك", accessRole: "owner" },
    "khalelkhalouf1196@gmail.com": { name: "خليل خلوف", role: "محاسب" }
  },
  ai: {
    ownerEmail: "ozkkhallouf@gmail.com",
    ownerEmails: ["ozkkhallouf@gmail.com", "ozkkhalouf@gmail.com"],
    claude: {
      apiKey: "",
      model: "claude-opus-4-8"
    },
    chatgpt: {
      apiKey: "",
      model: "gpt-4o"
    }
  },
  supabase: {
    url: "https://dyxbirfpxeocqffnfdeb.supabase.co",
    publishableKey: "sb_publishable_RkM_QDWxk8Yekqz9KBKXBw_Yl14zhSH",
    requestsTable: "customer_requests",
    inventoryReportsTable: "inventory_reports",
    warehouseStockReportsTable: "ameen_warehouse_stock_reports",
    warehouseTransferReportsTable: "ameen_warehouse_transfer_reports",
    creditLimitsTable: "customer_credit_limits",
    approvedPricesTable: "approved_price_items",
    purchaseInvoicesTable: "purchase_invoices"
  }
};

window.roadmapItems = [
  {
    id: "login",
    title: "تسجيل الدخول",
    detail: "واجهة دخول عربية للموظفين والإدارة، تعمل محليا الآن وتتحول إلى Supabase عند إضافة المفاتيح."
  },
  {
    id: "requests",
    title: "طلبات العملاء",
    detail: "تسجيل طلبات العملاء وحفظها محليا أثناء التطوير أو داخل قاعدة Supabase بعد التفعيل."
  },
  {
    id: "remote",
    title: "الإدارة عن بعد",
    detail: "متابعة مهام الدعم، الفروع، وقنوات التواصل من أي جهاز."
  },
  {
    id: "monitoring",
    title: "المراقبة",
    detail: "مؤشرات تشغيلية للطلبات المفتوحة، سرعة الاستجابة، وحالة الخدمات."
  },
  {
    id: "payments",
    title: "الدفع",
    detail: "واجهة دفع مبدئية. الربط الحقيقي يحتاج مزود دفع يقبل نشاط الشركة وقواعد بلدك."
  },
  {
    id: "hosting",
    title: "النشر",
    detail: "منشور الآن على GitHub Pages، ويمكن نقله لاحقا إلى خادم سحابي أو منصة استضافة."
  },
  {
    id: "ameen",
    title: "تقارير الأمين",
    detail: "رفع جرد الأمين ولائحة الأسعار لإظهار تنبيهات قريب النفاد والمواد الراكدة والفعالة من الهاتف."
  }
];

window.platformChecks = [
  {
    name: "ويندوز",
    status: "جاهز",
    detail: "يعمل من متصفح Edge أو Chrome على اللابتوب."
  },
  {
    name: "آيفون",
    status: "جاهز عبر الرابط العام",
    detail: "افتح رابط GitHub Pages من Safari ويمكن إضافته إلى الشاشة الرئيسية."
  },
  {
    name: "ماك",
    status: "جاهز",
    detail: "يعمل من Safari أو Chrome بدون Xcode."
  },
  {
    name: "أندرويد",
    status: "مدعوم",
    detail: "يعمل من Chrome ويمكن تثبيته كتطبيق ويب."
  }
];

window.monitoringCards = [
  { label: "طلبات مفتوحة", value: "12", trend: "تحتاج متابعة" },
  { label: "زمن الرد", value: "8 د", trend: "جيد" },
  { label: "قنوات نشطة", value: "3", trend: "واتساب، هاتف، ويب" },
  { label: "حالة النظام", value: "مستقر", trend: "لا توجد أعطال" }
];

window.remoteServices = [
  "متابعة طلبات العملاء من الهاتف والكمبيوتر",
  "توزيع الطلبات على الموظفين",
  "مراقبة حالة الدعم والفروع",
  "تجهيز تقارير يومية للإدارة"
];
