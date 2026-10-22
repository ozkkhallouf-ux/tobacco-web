"use strict";
// سجل محلي لمحاولات الطباعة (JSON Lines) — لا يكتب شيئاً في قاعدة الأمين.
// كل سطر حدث مستقل يُضاف ولا يُعدَّل: preview / print_requested / print_sent /
// print_failed / print_rejected / dry_run.
const fs = require("fs");
const path = require("path");

function createPrintLog(filePath, deps) {
  const d = deps || {};
  const now = d.now || (() => new Date());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function append(event) {
    const entry = { at: now().toISOString(), ...event };
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  function readAll() {
    let text = "";
    try { text = fs.readFileSync(filePath, "utf8"); } catch { return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* سطر مبتور من انقطاع — يُتجاهل */ }
    }
    return out;
  }

  // الطبعات الناجحة السابقة لهذه الفاتورة على هذا الجهاز.
  function successfulPrints(guid) {
    return readAll().filter((e) => e.guid === guid && e.event === "print_sent");
  }

  function recent(limit) {
    const all = readAll();
    return all.slice(Math.max(0, all.length - (limit || 50))).reverse();
  }

  return { append, readAll, successfulPrints, recent, filePath };
}

module.exports = { createPrintLog };
