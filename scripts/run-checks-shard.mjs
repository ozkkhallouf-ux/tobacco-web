// ============================================================================
// منطق وسائط `npm run check` وتقسيمه إلى shards — دوال نقية بلا آثار جانبية.
//
// منفصل عن run-checks.mjs كي يُختبر وحده (scripts/check-run-checks-shard.mjs)
// دون تشغيل أي فحص. والاسم لا يبدأ بـcheck- عمداً: ليس فحصاً، فلا يدخل جرد
// checks.manifest.mjs.
//
// استراتيجيتان، كلتاهما حتمية (لا زمن تشغيل ولا عشوائية ولا بيئة)، والـshards
// فيهما متفرقة واتحادها هو CHECKS بالضبط، وكل shard يحفظ ترتيب البيان:
//   • round-robin (بلا --weights): الفحص رقم i يذهب إلى الـshard رقم (i mod n) + 1.
//   • weighted (مع --weights): LPT — الفحوص من الأثقل إلى الأخف (والتعادل بموضع
//     البيان)، كل فحص إلى الـshard الأقل حملاً حتى الآن (والتعادل بالأصغر رقماً).
//     الأوزان من scripts/checks.weights.json (أزمنة CI مقيسة). فحص غائب عن الملف
//     يأخذ defaultSeconds: الأوزان القديمة تُفسد التوازن فقط، لا التغطية أبداً.
//
// الصرامة مقصودة: أي وسيط غير معروف (خطأ إملائي مثل --shards) يُرفض بدل أن
// يُتجاهل — فالتجاهل كان سيشغّل البوابة كاملة أو، أسوأ، shard بلا علم أحد.
//
// تقرير الـshard (--report) وverifyShardReports: وظيفة التجميع في CI لا تكتفي
// بنتيجة الوظائف؛ تعيد حساب التقسيم المتوقع من البيان نفسه وتطابق كل تقرير معه،
// فتثبت أن كل فحص نُفِّذ ونجح مرة واحدة بالضبط في هذا التشغيل.
// ============================================================================

const SHARD_RE = /^([1-9]\d*)\/([1-9]\d*)$/;
export const REPORT_VERSION = 1;

export function parseShardSpec(spec) {
  const m = SHARD_RE.exec(String(spec ?? ''));
  if (!m) {
    throw new Error(`--shard يتطلب صيغة k/n بعددين صحيحين موجبين (مثل 2/4) — وجدت: "${spec ?? ''}"`);
  }
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (index > total) {
    throw new Error(`--shard ${spec}: رقم الـshard أكبر من عددها`);
  }
  return { index, total };
}

export function parseRunChecksArgs(argv) {
  const options = { shard: null, list: false, weights: null, report: null };
  const takeValue = (arg, i, flag) => {
    const value = arg === flag ? argv[i + 1] : arg.slice(flag.length + 1);
    if (!value || value.startsWith('--')) throw new Error(`${flag} يتطلب مساراً`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      options.list = true;
    } else if (arg === '--shard' || arg.startsWith('--shard=')) {
      if (options.shard) throw new Error('--shard مكرر');
      const value = arg === '--shard' ? argv[++i] : arg.slice('--shard='.length);
      options.shard = parseShardSpec(value);
    } else if (arg === '--weights' || arg.startsWith('--weights=')) {
      if (options.weights) throw new Error('--weights مكرر');
      options.weights = takeValue(arg, i, '--weights');
      if (arg === '--weights') i += 1;
    } else if (arg === '--report' || arg.startsWith('--report=')) {
      if (options.report) throw new Error('--report مكرر');
      options.report = takeValue(arg, i, '--report');
      if (arg === '--report') i += 1;
    } else {
      throw new Error(`وسيط غير معروف: "${arg}" — المسموح: --shard k/n و--weights <ملف> و--report <ملف> و--list`);
    }
  }
  if ((options.weights || options.report) && !options.shard) {
    throw new Error('--weights و--report لا معنى لهما بلا --shard');
  }
  return options;
}

// يتحقق من ملف الأوزان ويعيد { defaultSeconds, seconds: Map }.
export function parseWeights(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || data.version !== 1 || typeof data.seconds !== 'object' || data.seconds === null) {
    throw new Error('ملف الأوزان: يتطلب version: 1 وكائن seconds');
  }
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!valid(data.defaultSeconds)) throw new Error('ملف الأوزان: defaultSeconds رقم غير سالب');
  const seconds = new Map();
  for (const [name, value] of Object.entries(data.seconds)) {
    if (!valid(value)) throw new Error(`ملف الأوزان: وزن ${name} ليس رقماً غير سالب`);
    seconds.set(name, value);
  }
  return { defaultSeconds: data.defaultSeconds, seconds };
}

export function weightOf(weights, name) {
  return weights.seconds.has(name) ? weights.seconds.get(name) : weights.defaultSeconds;
}

// يعيد مصفوفة n من القوائم (كل قائمة بترتيب البيان).
export function partition(checks, total, weights = null) {
  if (total > checks.length) {
    // shard فارغ «ينجح» بلا تشغيل أي شيء — إشارة خضراء كاذبة.
    throw new Error(`عدد الـshards (${total}) أكبر من عدد الفحوص (${checks.length})`);
  }
  const owner = new Array(checks.length);
  if (!weights) {
    for (let i = 0; i < checks.length; i += 1) owner[i] = i % total;
  } else {
    const order = checks.map((name, i) => ({ i, w: weightOf(weights, name) }))
      .sort((a, b) => b.w - a.w || a.i - b.i);
    const loads = new Array(total).fill(0);
    for (const { i, w } of order) {
      let best = 0;
      for (let k = 1; k < total; k += 1) if (loads[k] < loads[best]) best = k;
      owner[i] = best;
      loads[best] += w;
    }
    // LPT قد يترك shard فارغاً حين تكون الأوزان صفرية؛ نرفض بدل نجاح كاذب.
    if (new Set(owner).size !== total) throw new Error('التقسيم الموزون ترك shard فارغاً');
  }
  const shards = Array.from({ length: total }, () => []);
  checks.forEach((name, i) => shards[owner[i]].push(name));
  return shards;
}

export function selectShard(checks, shard, weights = null) {
  if (!shard) return [...checks];
  try {
    return partition(checks, shard.total, weights)[shard.index - 1];
  } catch (error) {
    throw new Error(`--shard ${shard.index}/${shard.total}: ${error.message}`);
  }
}

export function strategyOf(weights) {
  return weights ? 'weighted' : 'round-robin';
}

export function buildShardReport({ checks, shard, weights, executed }) {
  return {
    version: REPORT_VERSION,
    shard: { index: shard.index, total: shard.total },
    strategy: strategyOf(weights),
    manifestSize: checks.length,
    executed: [...executed],
    passed: true,
  };
}

// يرمي عند أي انحراف؛ ويعيد ملخصاً عند السلامة. reports: كائنات JSON مقروءة.
export function verifyShardReports({ reports, checks, total, weights = null }) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`عدد shards غير صالح: ${total}`);
  const expected = partition(checks, total, weights);
  if (reports.length !== total) {
    throw new Error(`عدد التقارير ${reports.length} لا يساوي عدد الـshards ${total} — shard لم يُنفَّذ أو لم يرفع تقريره`);
  }
  const seenIndex = new Set();
  const seenCheck = new Map();
  for (const report of reports) {
    const where = `تقرير shard ${report?.shard?.index}/${report?.shard?.total}`;
    if (!report || report.version !== REPORT_VERSION) throw new Error(`${where}: إصدار غير معروف`);
    if (report.passed !== true) throw new Error(`${where}: لم ينجح`);
    if (report.shard?.total !== total) throw new Error(`${where}: عدد الـshards فيه لا يساوي ${total}`);
    const index = report.shard?.index;
    if (!Number.isInteger(index) || index < 1 || index > total) throw new Error(`${where}: رقم shard غير صالح`);
    if (seenIndex.has(index)) throw new Error(`${where}: الـshard نفسه مرتين`);
    seenIndex.add(index);
    if (report.strategy !== strategyOf(weights)) throw new Error(`${where}: استراتيجية ${report.strategy} لا ${strategyOf(weights)}`);
    if (report.manifestSize !== checks.length) throw new Error(`${where}: بيان بـ${report.manifestSize} فحصاً لا ${checks.length}`);
    if (!Array.isArray(report.executed)) throw new Error(`${where}: لا قائمة executed`);
    for (const name of report.executed) {
      if (seenCheck.has(name)) throw new Error(`${name} نُفِّذ في shardين (${seenCheck.get(name)} و${index})`);
      seenCheck.set(name, index);
    }
    const want = expected[index - 1];
    if (JSON.stringify(report.executed) !== JSON.stringify(want)) {
      const missing = want.filter((n) => !report.executed.includes(n));
      const extra = report.executed.filter((n) => !want.includes(n));
      throw new Error(`${where}: المنفَّذ لا يطابق المتوقع (ناقص: ${missing.join(', ') || '—'}؛ زائد: ${extra.join(', ') || '—'})`);
    }
  }
  const notRun = checks.filter((n) => !seenCheck.has(n));
  if (notRun.length) throw new Error(`فحوص لم تُنفَّذ في أي shard: ${notRun.join(', ')}`);
  if (seenCheck.size !== checks.length) throw new Error(`عدد المنفَّذ ${seenCheck.size} لا ${checks.length}`);
  return {
    executed: seenCheck.size,
    perShard: [...reports].sort((a, b) => a.shard.index - b.shard.index).map((r) => r.executed.length),
  };
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
