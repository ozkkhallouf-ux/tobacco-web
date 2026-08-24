import fs from "node:fs";
import vm from "node:vm";
const source=fs.readFileSync(new URL("../src/command-center.js",import.meta.url),"utf8");
const allowedRoutes=new Set();
const app={innerHTML:"",querySelectorAll:()=>[],querySelector:()=>null};
const document={querySelector:()=>null,querySelectorAll:()=>[],createElement:(tag)=>({tagName:String(tag).toUpperCase(),dataset:{},addEventListener:()=>{}})};
const window={location:{search:""},addEventListener:()=>{},ozkCanAccessRoute:()=>false};
const testConsole={...console,warn:()=>{},error:()=>{}};
const context={console:testConsole,Date,Math,Number,String,Array,Object,Promise,URLSearchParams,setTimeout:()=>0,setInterval:()=>0,clearInterval:()=>{},window,document,allowedRoutes,state:{route:"overview",session:null},app,shell:(x)=>x,render:()=>{},setRoute:()=>{}};
context.globalThis=context;vm.createContext(context);vm.runInContext(source,context,{filename:"command-center.js"});
if(!window.ozkCommandCenter?.answerQuestion||!window.ozkCommandCenter?.refresh)throw new Error("Command Center API missing");
const duplicateGuid="11111111-1111-4111-8111-111111111111";
if(window.ozkCommandCenter.dedupeRecommendations([{itemGuid:duplicateGuid},{itemGuid:duplicateGuid.toLowerCase()}]).length!==1)throw new Error("Command Center must emit at most one recommendation per canonical GUID");
if(!allowedRoutes.has("command"))throw new Error("Command route not registered");
const emptyAnswer=window.ozkCommandCenter.answerQuestion("today");
if(emptyAnswer!==null)throw new Error("Command Center should not answer before executive brief is loaded");
for (const label of ["رقم الصنف:", "حالة المخزون:", "الوحدة الأولى:", "الوحدة الثانية:", "حالة الحركة:", "المخزون الحالي غير محدث؛ الكميات الرقمية معطلة."]) {
  if (!source.includes(label)) throw new Error(`Purchase recommendation display is missing: ${label}`);
}
for (const file of ["supabase-client.js", "supplier-obligations-client.js", "web-push.js", "ameen-live-client.js"]) {
  const clientSource = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  if (!clientSource.includes("window.ozkSupabaseClient")) throw new Error(`${file} does not reuse the canonical Supabase browser client`);
}
if(!source.includes("Promise.allSettled"))throw new Error("Ameen Live resources must tolerate partial failure");
if(source.includes("Promise.all([window.ozkAmeenLive.health()"))throw new Error("Ameen Live resources must not share a fail-fast Promise.all");

context.state.session={id:"contract-test"};
const health={ok:true};
const stock={asOf:new Date().toISOString(),rowCount:1,rows:[{item_guid:"22222222-2222-4222-8222-222222222222",stock_qty:4}]};
const customers={asOf:new Date().toISOString(),rowCount:1,rows:[{customer_guid:"33333333-3333-4333-8333-333333333333"}]};
const pass=(value)=>async()=>value;
const fail=(name)=>async()=>{throw new Error(`${name} failed`);};
async function refreshWith(resources){
  window.ozkAmeenLive=resources;
  await window.ozkCommandCenter.refreshFromAmeen();
  return window.ozkAmeenLiveCache;
}

const allPass=await refreshWith({health:pass(health),stock:pass(stock),customers:pass(customers)});
if(allPass?.health!==health||allPass?.stock!==stock||allPass?.customers!==customers||Number.isNaN(Date.parse(allPass.updatedAt)))throw new Error("A: all successful Ameen Live resources must be cached");

const healthFails=await refreshWith({health:fail("health"),stock:pass(stock),customers:pass(customers)});
if(healthFails?.health!==null||healthFails?.stock!==stock||healthFails?.customers!==customers)throw new Error("B: health failure must not discard successful stock");

const customersFail=await refreshWith({health:pass(health),stock:pass(stock),customers:fail("customers")});
if(customersFail?.health!==health||customersFail?.stock!==stock||customersFail?.customers!==null)throw new Error("C: customers failure must not discard successful stock");

const diagnosticsFail=await refreshWith({health:fail("health"),stock:pass(stock),customers:fail("customers")});
if(diagnosticsFail?.health!==null||diagnosticsFail?.stock!==stock||diagnosticsFail?.customers!==null)throw new Error("D/G: partial success must retain stock without throwing");

window.ozkAmeenLiveCache=Object.freeze({stock,updatedAt:new Date().toISOString()});
const stockFails=await refreshWith({health:pass(health),stock:fail("stock"),customers:pass(customers)});
if(stockFails?.health!==health||stockFails?.stock!==null||stockFails?.customers!==customers)throw new Error("E: failed stock must be cleared while other successful resources are retained");
if(Object.prototype.hasOwnProperty.call(stockFails,"stockAsOf"))throw new Error("E: failed stock must not invent stockAsOf freshness");

// --- Auto-refresh (ensureFreshAmeenLiveStock) contract ---
// Freshness contract must match business-snapshot.js's own AMEEN_LIVE_MAX_AGE_MINUTES (currently 15 minutes).
if(!/AMEEN_LIVE_MAX_AGE_MINUTES\s*=\s*15\b/.test(source))throw new Error("K: command-center.js freshness window must stay 15 minutes, matching business-snapshot.js");
const snapshotSource=fs.readFileSync(new URL("../src/business-snapshot.js",import.meta.url),"utf8");
if(!/AMEEN_LIVE_MAX_AGE_MINUTES\s*=\s*15\b/.test(snapshotSource))throw new Error("K: business-snapshot.js freshness window changed — auto-refresh contract out of sync");
if(!source.includes("ensureFreshAmeenLiveStock"))throw new Error("Auto-refresh orchestration function is missing");

function freshVm(resources, cache) {
  const routes=new Set();
  const evtApp={innerHTML:"",querySelectorAll:()=>[],querySelector:()=>null};
  const evtDoc={querySelector:()=>null,querySelectorAll:()=>[],createElement:(tag)=>({tagName:String(tag).toUpperCase(),dataset:{},addEventListener:()=>{}})};
  const timers=[];
  // Populate ozkAmeenLive/ozkAmeenLiveCache BEFORE the script's own trailing render() runs during
  // construction (mirrors production, where ameen-live-client.js loads before command-center.js) —
  // otherwise the construction-time render would consume the cooldown against an undefined client.
  const evtWin={location:{search:""},addEventListener:()=>{},ozkCanAccessRoute:()=>true,ozkAmeenLive:resources,ozkAmeenLiveCache:cache??null};
  const evtCtx={console:testConsole,Date,Math,Number,String,Array,Object,Promise,URLSearchParams,setTimeout:(fn)=>{timers.push(fn);return timers.length;},setInterval:()=>0,clearInterval:()=>{},window:evtWin,document:evtDoc,allowedRoutes:routes,state:{route:"command",session:{id:"auto-refresh-test"}},app:evtApp,shell:(x)=>x,render:()=>{},setRoute:()=>{}};
  evtCtx.globalThis=evtCtx;vm.createContext(evtCtx);vm.runInContext(source,evtCtx,{filename:"command-center.js"});
  return {win:evtWin,ctx:evtCtx};
}
async function settle(){ await new Promise((resolve)=>setTimeout(resolve,0)); await new Promise((resolve)=>setTimeout(resolve,0)); }

// TEST A/C: missing or stale cache at Command Center render (init/navigation) -> exactly one automatic Ameen refresh.
{
  let stockCalls=0;
  const resources={health:pass(health),stock:async()=>{stockCalls++;return stock;},customers:pass(customers)};
  const {win}=freshVm(resources,null);
  await settle();
  if(stockCalls!==1)throw new Error(`TEST A: expected exactly one automatic Ameen refresh on empty cache, got ${stockCalls}`);
  if(!win.ozkAmeenLiveCache?.stock)throw new Error("TEST A: automatic refresh must populate the live cache");
}

// TEST B: fresh Live cache -> render must not request stock again.
{
  let stockCalls=0;
  const resources={health:pass(health),stock:async()=>{stockCalls++;return stock;},customers:pass(customers)};
  const cache={stock,health,customers,updatedAt:new Date().toISOString()};
  const {ctx}=freshVm(resources,cache);
  await settle();
  ctx.render();
  await settle();
  if(stockCalls!==0)throw new Error(`TEST B: fresh Ameen Live cache must not trigger a redundant automatic refresh, got ${stockCalls}`);
}

// TEST C: stale (>15m) Live cache -> automatic refresh occurs.
{
  let stockCalls=0;
  const resources={health:pass(health),stock:async()=>{stockCalls++;return stock;},customers:pass(customers)};
  const cache={stock,health,customers,updatedAt:new Date(Date.now()-20*60*1000).toISOString()};
  const {win}=freshVm(resources,cache);
  await settle();
  if(stockCalls!==1)throw new Error(`TEST C: stale Ameen Live cache must trigger exactly one automatic refresh, got ${stockCalls}`);
  if(!win.ozkAmeenLiveCache?.stock)throw new Error("TEST C: automatic refresh must replace the stale cache with fresh data");
}

// TEST D/I: duplicate/concurrent automatic triggers right after init must not create a second in-flight
// or immediate-retry Ameen request (no request storm, single in-flight refresh at a time).
{
  let stockCalls=0;
  const resources={health:pass(health),stock:async()=>{stockCalls++;return stock;},customers:pass(customers)};
  const {win,ctx}=freshVm(resources,null);
  win.ozkCommandCenter.ensureFreshAmeenLiveStock();
  ctx.render();
  await settle();
  if(stockCalls!==1)throw new Error(`TEST D/I: concurrent/duplicate automatic triggers must not create more than one Ameen request, got ${stockCalls}`);
  ctx.render();
  await settle();
  if(stockCalls!==1)throw new Error(`TEST I: an immediate follow-up render after a successful refresh must not retry within the cooldown, got ${stockCalls}`);
}

// TEST E/F/G equivalents (auto path): a failed automatic attempt must not throw, must not fabricate
// freshness, and must not enter an uncontrolled retry loop across consecutive renders.
{
  let stockCalls=0;
  const resources={health:pass(health),stock:async()=>{stockCalls++;throw new Error("stock failed");},customers:pass(customers)};
  const {win,ctx}=freshVm(resources,null);
  await settle();
  ctx.render();
  await settle();
  ctx.render();
  await settle();
  if(stockCalls!==1)throw new Error(`TEST I: a failing automatic refresh must not retry on every subsequent render (storm), got ${stockCalls} attempts`);
  if(win.ozkAmeenLiveCache?.stock!==null)throw new Error("TEST H: a failed automatic refresh must not fabricate stock (fallback stays untrusted)");
  if(win.ozkAmeenLiveCache&&Object.prototype.hasOwnProperty.call(win.ozkAmeenLiveCache,"stockAsOf"))throw new Error("TEST H: a failed automatic refresh must not invent stockAsOf freshness");
}

// TEST J: manual "تحديث من الأمين" (direct refreshFromAmeen) must keep working and bypass the cooldown gate.
{
  let stockCalls=0;
  const resources={health:pass(health),stock:async()=>{stockCalls++;return stock;},customers:pass(customers)};
  const {win}=freshVm(resources,null);
  await settle();
  if(stockCalls!==1)throw new Error("TEST J setup: automatic refresh should have run once first");
  await win.ozkCommandCenter.refreshFromAmeen();
  if(stockCalls!==2)throw new Error(`TEST J: manual refresh must still issue an Ameen request even inside the automatic cooldown window, got ${stockCalls}`);
}

console.log("OZK Command Center contract: OK");
