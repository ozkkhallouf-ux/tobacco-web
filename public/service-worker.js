const CACHE_NAME = "web-platform-tobacco-v630";
const ASSETS = [
  "./","index.html","404.html","src/app.js","src/icloud-archive.js","src/price-list-template.js","src/config.js","src/supabase-client.js","src/smart-inventory.js","src/web-push.js","src/purchase-business-settings.js","src/purchase-recommendation.js","src/business-snapshot.js","src/business-metrics.js","src/executive-team.js","src/ameen-live-client.js","src/command-center.js","src/styles.css","src/decision-engine.js","src/decision-engine.css","src/command-center.css","src/decision-data-bridge.js","src/supplier-obligations-client.js","src/decision-supplier-overlay.js","src/purchase-invoice-calc.js","src/inventory-recon-calc.js","public/manifest.webmanifest","public/icons/app-icon.png","public/icons/ozk-ios-full-notification-icon.png","public/icons/ozk-logo.png","public/icons/workspace-pattern.svg","public/vendor/html2pdf.bundle.min.js","public/vendor/supabase.js","public/vendor/xlsx.full.min.js"
];
// `cache:"reload"` في التحميل المسبق إلزامي: بدونه يمرّ addAll عبر كاش HTTP
// (max-age=600 على GitHub Pages) فيملأ الـservice worker الجديد كاشه بملفات
// قديمة، ثم يقدّمها للصفحة بعد activate — فيبدو التحديث وكأنه لم يحدث.
// "reload" يتجاوز كاش HTTP **ويحدّثه أيضاً**، فيصير الطلب التالي من معالج
// fetch طازجاً بلا لمس ذلك المعالج ولا كسر سلوك offline.
self.addEventListener("install",(event)=>{event.waitUntil(caches.open(CACHE_NAME).then((cache)=>cache.addAll(ASSETS.map((asset)=>new Request(asset,{cache:"reload"})))));self.skipWaiting();});
// **ممنوع إعادة تنقيل التبويبات المفتوحة من هنا.** كان activate ينقّل كل
// نافذة في النطاق عبر واجهة الـclient، فيعيد تحميلها قسراً عند تفعيل أي
// service worker جديد — بما فيها تبويب لم يلمسه المستخدم. قياس بتبويبين: بعد
// نشر جديد وإعادة تحميل التبويب A وحده، أُعيد تنقيل التبويب B مرة واحدة،
// فتضيع إدخالاته غير المحفوظة. كان السلوك خاملاً فعلياً لأن الـSW لم يكن
// يُفعَّل أصلاً (عطل updateViaCache)، وإصلاح ذلك العطل كان سيجعله حيّاً.
// سلامة عمل المستخدم أهم من فرض التحديث فوراً: التبويب يبقى كما هو حتى ينتقل
// المستخدم أو يعيد التحميل بنفسه، وعندها يحصل على الأصول الجديدة.
// وبزوال التنقيل يزول سبب استثناء روابط استرداد كلمة المرور — لم يعد هناك ما
// يقاطعها. skipWaiting وclients.claim يبقيان: كلاهما لا يعيد تحميل أي صفحة.
self.addEventListener("activate",(event)=>{event.waitUntil((async()=>{await Promise.all((await caches.keys()).filter((key)=>key!==CACHE_NAME).map((key)=>caches.delete(key)));await self.clients.claim();})());});
self.addEventListener("push",(event)=>{let payload={};try{payload=event.data?.json?.()||{};}catch{payload={notification:{body:event.data?.text?.()||""}};}const notification=payload.notification||payload;const title=String(notification.title||"OZK TOBACCO");const navigate=String(notification.navigate||"/?route=overview");event.waitUntil(self.registration.showNotification(title,{body:String(notification.body||""),icon:notification.icon||"public/icons/ozk-ios-full-notification-icon.png",badge:"public/icons/app-icon.png",tag:notification.tag||"ozk-alert",dir:"rtl",lang:"ar",data:{navigate}}));});
self.addEventListener("notificationclick",(event)=>{event.notification.close();const target=new URL(event.notification?.data?.navigate||"/?route=overview",self.registration.scope).href;event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(async(list)=>{const existing=list.find((client)=>client.url.startsWith(self.registration.scope));if(existing){await existing.focus();if("navigate" in existing)await existing.navigate(target);return;}return clients.openWindow(target);}));});
self.addEventListener("fetch",(event)=>{if(event.request.method!=="GET")return;event.respondWith(fetch(event.request).then((response)=>{const copy=response.clone();caches.open(CACHE_NAME).then((cache)=>cache.put(event.request,copy));return response;}).catch(()=>caches.match(event.request).then((cached)=>cached||caches.match("index.html"))));});
