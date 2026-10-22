"use strict";
// منع الإرسال المكرر للطابعة.
//
// ثلاث طبقات مستقلة:
//  1. رمز المعاينة: لا طباعة بلا معاينة، وكل رمز يُستهلك عند أول إرسال ناجح.
//     الضغط المزدوج على «طباعة» يحمل الرمز نفسه، فالثاني يُرفض.
//  2. قفل «قيد الإرسال» لكل فاتورة: طلبان متزامنان لنفس الفاتورة ⇒ الثاني يُرفض.
//  3. فاتورة طُبعت سابقاً على هذا الجهاز (من السجل) ⇒ لا إعادة إلا بتأكيد صريح
//     confirmReprint، وبعد مهلة تهدئة قصيرة تمنع تأكيداً مزدوجاً بنقرتين.

const crypto = require("crypto");

const TOKEN_TTL_MS = 30 * 60 * 1000;
const REPRINT_COOLDOWN_MS = 10 * 1000;

function rejection(code, message, extra) {
  return { ok: false, code, message, ...extra };
}

function createPrintGuard(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const log = d.log; // createPrintLog
  const tokens = new Map(); // token → { guid, pdfPath, paper, createdAt, used }
  const inflight = new Set();
  const lastSentAt = new Map(); // guid → ms

  function issue(guid, info) {
    const token = crypto.randomBytes(16).toString("hex");
    tokens.set(token, { guid, ...info, createdAt: now(), used: false });
    for (const [t, v] of tokens) if (now() - v.createdAt > TOKEN_TTL_MS) tokens.delete(t);
    return token;
  }

  function lookup(token) {
    return tokens.get(String(token || "")) || null;
  }

  // يقرّر هل يُسمح بالإرسال الآن. عند السماح يحجز القفل ويُعيد release().
  function begin(token, opts) {
    const o = opts || {};
    const t = lookup(token);
    if (!t) return rejection("NO_PREVIEW", "انتهت صلاحية المعاينة أو غير موجودة — اعرض المعاينة من جديد.");
    if (now() - t.createdAt > TOKEN_TTL_MS) {
      return rejection("PREVIEW_EXPIRED", "مضى وقت طويل على المعاينة — اعرضها من جديد قبل الطباعة.");
    }
    if (inflight.has(t.guid)) return rejection("IN_FLIGHT", "هذه الفاتورة قيد الإرسال للطابعة الآن.");
    const last = lastSentAt.get(t.guid);
    if (last !== undefined && now() - last < REPRINT_COOLDOWN_MS) {
      return rejection("COOLDOWN", "أُرسلت هذه الفاتورة للتو — انتظر ثوانٍ قبل إعادة الطباعة.");
    }
    const previous = log ? log.successfulPrints(t.guid) : [];
    if (t.used || previous.length) {
      if (!o.confirmReprint) {
        return rejection("NEEDS_CONFIRM", "طُبعت هذه الفاتورة سابقاً على هذا الجهاز. أكّد إعادة الطباعة.", {
          previous: previous.slice(-5),
        });
      }
    }
    inflight.add(t.guid);
    let done = false;
    return {
      ok: true,
      entry: t,
      reprint: t.used || previous.length > 0,
      finish(success) {
        if (done) return;
        done = true;
        inflight.delete(t.guid);
        if (success) {
          t.used = true;
          lastSentAt.set(t.guid, now());
        }
      },
    };
  }

  return { issue, lookup, begin };
}

module.exports = { createPrintGuard, TOKEN_TTL_MS, REPRINT_COOLDOWN_MS };
