// كتابة الملف داخل مجلد iCloud الصحيح مع منع التكرار ومنع استبدال أي ملف قائم.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFileName, variantName } from "./naming.mjs";
import { discoverFolders, resolveFolderPath, ICLOUD_ROOT } from "./folders.mjs";

const MAX_VARIANTS = 30;
const PDF_MAGIC = "%PDF-";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// حقول زمنية يكتبها كل مولّد PDF (Chromium و jsPDF معاً) بلحظة التوليد، فتختلف
// بايتات ملفين متطابقين تماماً في المضمون لمجرد أنهما وُلّدا في ثانيتين مختلفتين.
// قياس فعلي (2026-08-31): تصديران متتاليان لنفس كشف الحساب اختلفا في 28 بايت
// فقط، كلها داخل CreationDate/ModDate — وكان الناتج نسخة «(2)» زائدة في الأرشيف.
// نطبّعها قبل المقارنة فقط؛ الملف يُكتب كما وصل بلا أي تعديل.
const VOLATILE_PDF_FIELDS = [
  [/\/CreationDate\s*\(D:[^)]*\)/g, "/CreationDate ()"],
  [/\/ModDate\s*\(D:[^)]*\)/g, "/ModDate ()"],
  [/\/ID\s*\[\s*<[0-9a-fA-F]*>\s*<[0-9a-fA-F]*>\s*\]/g, "/ID []"]
];

/** بصمة محتوى مستقلة عن لحظة التوليد — أساس منع التكرار. */
export function pdfFingerprint(buffer) {
  let text = buffer.toString("latin1");
  for (const [pattern, replacement] of VOLATILE_PDF_FIELDS) text = text.replace(pattern, replacement);
  return sha256(Buffer.from(text, "latin1"));
}

/** يتحقق أن المحتوى ملف PDF فعلي لا شيء آخر أُعيد تسميته. */
export function assertPdf(buffer) {
  if (!buffer || buffer.length < 1024) throw new Error("ملف PDF فارغ أو أصغر من أن يكون مستنداً صالحاً");
  if (buffer.subarray(0, 5).toString("latin1") !== PDF_MAGIC) throw new Error("المحتوى ليس ملف PDF");
}

/**
 * يحفظ مستنداً مؤرشفاً.
 * @param {Buffer} pdf
 * @param {string} docType
 * @param {object} meta
 * @param {{root?:string, now?:Date}} options
 * @returns {Promise<{status:"saved"|"duplicate", folder:string, file:string, path:string, bytes:number}>}
 */
export async function archiveDocument(pdf, docType, meta = {}, options = {}) {
  const root = options.root || ICLOUD_ROOT;
  assertPdf(pdf);

  const { name, folder } = buildFileName(docType, meta, options.now || new Date());
  const folders = await discoverFolders(root);
  const dir = resolveFolderPath(folders, folder, root);

  const digest = pdfFingerprint(pdf);

  for (let index = 1; index <= MAX_VARIANTS; index += 1) {
    const candidate = index === 1 ? name : variantName(name, index);
    const target = path.join(dir, candidate);

    // حارس تراجعي أخير: الاسم المبني يجب أن يبقى داخل المجلد الهدف مباشرة.
    if (path.dirname(path.resolve(target)) !== path.resolve(dir)) {
      throw new Error("مسار الحفظ خرج عن المجلد المسموح");
    }

    let existing = null;
    try {
      existing = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (existing) {
      // الملف نفسه بالمحتوى نفسه: تصدير مكرر (نقرة مزدوجة مثلاً) — لا نكتب شيئاً.
      if (pdfFingerprint(existing) === digest) {
        return { status: "duplicate", folder, file: candidate, path: target, bytes: existing.length };
      }
      continue; // اسم محجوز بمحتوى مختلف: ننتقل لنسخة مرقّمة ولا نستبدل أبداً
    }

    try {
      // wx = إنشاء حصري: يفشل إن وُجد الملف. يمنع أي استبدال حتى مع تسابق طلبين.
      await writeFile(target, pdf, { flag: "wx", mode: 0o644 });
      return { status: "saved", folder, file: candidate, path: target, bytes: pdf.length };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // ملف ظهر بين الفحص والكتابة — أعد المحاولة على الاسم التالي.
    }
  }

  throw new Error("تعذّر إيجاد اسم متاح بعد عدة محاولات");
}
