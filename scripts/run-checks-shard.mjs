// ============================================================================
// منطق وسائط `npm run check` وتقسيمه إلى shards — دوال نقية بلا آثار جانبية.
//
// منفصل عن run-checks.mjs كي يُختبر وحده (scripts/check-run-checks-shard.mjs)
// دون تشغيل أي فحص. والاسم لا يبدأ بـcheck- عمداً: ليس فحصاً، فلا يدخل جرد
// checks.manifest.mjs.
//
// التقسيم حتمي بالموضع في CHECKS (round-robin): الفحص رقم i يذهب إلى الـshard
// رقم (i mod n) + 1. فلا يعتمد على زمن ولا عشوائية ولا بيئة، والـshards متفرقة
// واتحادها هو CHECKS بالضبط، وكل shard يحفظ ترتيب البيان.
//
// الصرامة مقصودة: أي وسيط غير معروف (خطأ إملائي مثل --shards) يُرفض بدل أن
// يُتجاهل — فالتجاهل كان سيشغّل البوابة كاملة أو، أسوأ، shard بلا علم أحد.
// ============================================================================

const SHARD_RE = /^([1-9]\d*)\/([1-9]\d*)$/;

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
  const options = { shard: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      options.list = true;
    } else if (arg === '--shard' || arg.startsWith('--shard=')) {
      if (options.shard) throw new Error('--shard مكرر');
      const value = arg === '--shard' ? argv[++i] : arg.slice('--shard='.length);
      options.shard = parseShardSpec(value);
    } else {
      throw new Error(`وسيط غير معروف: "${arg}" — المسموح: --shard k/n و--list`);
    }
  }
  return options;
}

export function selectShard(checks, shard) {
  if (!shard) return [...checks];
  if (shard.total > checks.length) {
    // shard فارغ «ينجح» بلا تشغيل أي شيء — إشارة خضراء كاذبة.
    throw new Error(`--shard ${shard.index}/${shard.total}: عدد الـshards أكبر من عدد الفحوص (${checks.length})`);
  }
  return checks.filter((_, i) => i % shard.total === shard.index - 1);
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
