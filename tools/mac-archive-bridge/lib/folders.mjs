// اكتشاف مجلدات iCloud Drive الفعلية بدل الاعتماد على مسار ثابت هشّ.
//
// نقرأ محتوى الجذر مرة واحدة ونبني خريطة «مفتاح مطابع -> الاسم الحقيقي على
// القرص». الاسم الحقيقي هو ما نبني به المسار دائماً (قد يكون NFD أو يبدأ
// بـU+200F)؛ المفتاح المطبَّع للمقارنة فقط.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { folderKey } from "./arabic.mjs";
import { REQUIRED_FOLDERS } from "./doc-types.mjs";

export const ICLOUD_ROOT = path.join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");

/**
 * يبني خريطة المجلدات الموجودة فعلياً.
 * @param {string} root جذر iCloud Drive (قابل للحقن في الاختبارات)
 * @returns {Promise<Map<string,string>>} مفتاح مطبَّع -> اسم المجلد كما هو على القرص
 */
export async function discoverFolders(root = ICLOUD_ROOT) {
  const map = new Map();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return map; // الجذر غير موجود (iCloud غير مفعّل مثلاً) — نرجع خريطة فارغة
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const key = folderKey(entry.name);
    // أول تطابق يفوز: لو وُجد مجلدان يتطابقان بعد التطبيع نبقي الأقدم ولا نخمّن.
    if (!map.has(key)) map.set(key, entry.name);
  }
  return map;
}

/**
 * يحلّ اسم مجلد منطقي إلى مسار مطلق حقيقي.
 * يرمي Error واضحاً إذا كان المجلد غير موجود — لا ينشئ مجلدات من تلقاء نفسه.
 */
export function resolveFolderPath(folders, wantedName, root = ICLOUD_ROOT) {
  const actual = folders.get(folderKey(wantedName));
  if (!actual) throw new Error(`مجلد iCloud غير موجود: ${wantedName}`);
  const full = path.join(root, actual);
  // حارس تراجعي: المسار الناتج يجب أن يبقى ابناً مباشراً للجذر.
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || rel.includes(path.sep)) {
    throw new Error(`مسار مجلد غير صالح: ${wantedName}`);
  }
  return full;
}

/** أسماء المجلدات المطلوبة وغير الموجودة حالياً. */
export function missingFolders(folders) {
  return REQUIRED_FOLDERS.filter((name) => !folders.has(folderKey(name)));
}

/** يتحقق أن الجذر نفسه موجود ومجلد. */
export async function rootReady(root = ICLOUD_ROOT) {
  try {
    const info = await stat(root);
    return info.isDirectory();
  } catch {
    return false;
  }
}
