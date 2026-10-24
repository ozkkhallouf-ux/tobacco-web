"use strict";
// تحويل HTML ← PDF بـEdge/Chrome المثبّت، بتبعية puppeteer-core الخاصة بالعامل.
// لا يُستورد محوّل أداة الطباعة اليدوية: require("puppeteer-core") داخله يُحلّ من مجلد
// الأداة لا من مجلد العامل، فيفشل على تثبيت فيه تبعيات العامل وحده (Codex P1 على #359).
// نفس الإعدادات (الورق، تعطيل JS، التحقق من خط Cairo) من lib/paper المشتركة.

const fs = require("fs");
const { pdfOptions, applyPaperCss } = require("../../manual-a4-print/lib/paper");

function findBrowser(browserPath) {
  const candidates = [
    browserPath,
    process.env.OZK_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || "";
}

function countPdfPages(buf) {
  const m = Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

// يرمي عند غياب التبعية بدل الفشل لاحقاً عند أول فاتورة؛ يستدعيه --health.
function puppeteerPath() {
  return require.resolve("puppeteer-core");
}

function createRenderer({ browserPath } = {}) {
  let browserPromise = null;
  async function browser() {
    if (browserPromise) {
      const b = await browserPromise.catch(() => null);
      if (b && b.connected) return b;
    }
    const executablePath = findBrowser(browserPath);
    if (!executablePath) throw new Error("لم يُعثر على Microsoft Edge أو Chrome لتوليد PDF");
    const puppeteer = require("puppeteer-core");
    browserPromise = puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-first-run", "--disable-extensions", "--disable-gpu"]
        .concat(process.platform !== "win32" && process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
    });
    return browserPromise;
  }
  async function render(html, paper, outPath) {
    const page = await (await browser()).newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setContent(applyPaperCss(html, paper), { waitUntil: "load" });
      await page.evaluateHandle("document.fonts.ready").catch(() => {});
      const fontOk = await page.evaluate(
        "document.fonts.check('700 16px Cairo') && document.fonts.check('400 13px Cairo') && [...document.fonts].some(f => f.family.replace(/\"/g,'') === 'Cairo' && f.status === 'loaded')"
      ).catch(() => false);
      const pdf = await page.pdf({ ...pdfOptions(paper), path: outPath });
      return { fontOk: Boolean(fontOk), pages: countPdfPages(pdf), bytes: pdf.length };
    } finally {
      await page.close().catch(() => {});
    }
  }
  async function close() {
    if (browserPromise) { const b = await browserPromise.catch(() => null); if (b) await b.close().catch(() => {}); }
  }
  return { render, close, browserPath: () => findBrowser(browserPath) };
}

module.exports = { createRenderer, puppeteerPath, findBrowser, countPdfPages };
