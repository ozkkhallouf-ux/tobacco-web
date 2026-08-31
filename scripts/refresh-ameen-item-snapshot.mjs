import { buildItemSnapshot, getSalesWindow, SNAPSHOT_FIELDS } from './item-snapshot-pipeline.mjs';
import {
  SALES_SYNC_SOURCE,
  assertTrustedSalesInput,
  getSingleSalesSyncMarker,
  validateSalesSyncMarker,
} from './item-snapshot-freshness.mjs';

const argumentsList = process.argv.slice(2);
const apply = argumentsList.includes('--apply');
const windowEndArgument = argumentsList.find((argument) => argument.startsWith('--window-end='));
const windowEnd = windowEndArgument?.slice('--window-end='.length) ?? localDateString(new Date());
const supabaseUrl = (process.env.TOBACCO_SUPABASE_URL || 'https://dyxbirfpxeocqffnfdeb.supabase.co').replace(/\/$/, '');
const publicKey = process.env.TOBACCO_SUPABASE_PUBLIC_KEY || process.env.SUPABASE_PUBLIC_KEY;
const email = process.env.TOBACCO_SYNC_EMAIL;
const password = process.env.TOBACCO_SYNC_PASSWORD;
const PUBLIC_PROFILE = 'public';

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function requireSetting(value, name) {
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

function publicRestHeaders(headers, { write = false } = {}) {
  return {
    ...headers,
    'Accept-Profile': PUBLIC_PROFILE,
    ...(write ? { 'Content-Profile': PUBLIC_PROFILE } : {}),
  };
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Supabase request failed (${response.status}): ${detail}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function authenticate() {
  const key = requireSetting(publicKey, 'TOBACCO_SUPABASE_PUBLIC_KEY');
  const session = await request(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: requireSetting(email, 'TOBACCO_SYNC_EMAIL'),
      password: requireSetting(password, 'TOBACCO_SYNC_PASSWORD') }),
  });
  return { apikey: key, Authorization: `Bearer ${session.access_token}` };
}

async function readAll(table, select, order, headers, filters = []) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set('select', select);
    url.searchParams.set('order', order);
    for (const [name, value] of filters) url.searchParams.append(name, value);
    const page = await request(url, {
      headers: {
        ...publicRestHeaders(headers, { write: false }),
        Range: `${offset}-${offset + pageSize - 1}`,
      },
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function main() {
  const headers = await authenticate();
  const window = getSalesWindow(windowEnd, 30);
  const markerSelect = 'source,sync_run_id,window_start,window_end,row_count,completed_at';
  const markerFilters = [['source', `eq.${SALES_SYNC_SOURCE}`]];
  const markerBefore = getSingleSalesSyncMarker(await readAll(
    'sales_line_items_sync_state', markerSelect, 'source.asc', headers, markerFilters,
  ));
  validateSalesSyncMarker(markerBefore, window);
  const [currentSnapshot, itemCosts, salesLineItems] = await Promise.all([
    readAll('ameen_item_snapshot', SNAPSHOT_FIELDS.join(','), 'item_key.asc', headers),
    readAll('item_costs', 'match_key,item_guid,item_name,avg_cost,currency,updated_at', 'match_key.asc', headers),
    readAll('sales_line_items', 'id,source_key,item_key,item_name,qty,sale_date,bill_type,unit2_name,unit2_factor',
      'id.asc', headers, [['sale_date', `gte.${window.start}`], ['sale_date', `lte.${window.end}`]]),
  ]);
  const markerAfter = getSingleSalesSyncMarker(await readAll(
    'sales_line_items_sync_state', markerSelect, 'source.asc', headers, markerFilters,
  ));
  const trustedSalesSync = assertTrustedSalesInput({
    markerBefore, markerAfter, salesLineItems, snapshotWindow: window,
  });
  const result = buildItemSnapshot({ currentSnapshot, itemCosts, salesLineItems, windowEnd });
  console.log(`sales sync trusted: run=${trustedSalesSync.syncRunId} completed=${trustedSalesSync.completedAt} marker_window=${trustedSalesSync.windowStart}..${trustedSalesSync.windowEnd}`);
  console.log(`snapshot rows=${result.rows.length} sales_items=${result.salesItemCount} window=${result.window.start}..${result.window.end}`);
  // Dry Run deliberately shares the Apply guard so its output is safe to approve later.
  if (!apply) {
    console.log('DRY RUN: trusted inputs verified; no Supabase write performed. Pass --apply only after review.');
    return;
  }

  const writeResult = await request(`${supabaseUrl}/rest/v1/rpc/replace_ameen_item_snapshot`, {
    method: 'POST',
    headers: { ...publicRestHeaders(headers, { write: true }), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_rows: result.rows,
      p_snapshot_window_start: result.window.start,
      p_snapshot_window_end: result.window.end,
      p_expected_sales_generation: {
        source: trustedSalesSync.source,
        sync_run_id: trustedSalesSync.syncRunId,
        window_start: trustedSalesSync.windowStart,
        window_end: trustedSalesSync.windowEnd,
        row_count: trustedSalesSync.rowCount,
        completed_at: trustedSalesSync.completedAt,
      },
    }),
  });
  const verification = await readAll('ameen_item_snapshot',
    'item_key,units_sold_30d,movement_rank,generated_at', 'item_key.asc', headers,
    [['generated_at', `eq.${result.generatedAt}`]]);
  const uniqueKeys = new Set(verification.map((row) => row.item_key));
  if (verification.length !== result.rows.length || uniqueKeys.size !== result.rows.length) {
    throw new Error(`post-write verification failed: expected ${result.rows.length}, received ${verification.length}`);
  }
  console.log(`Supabase snapshot replaced atomically and verified (${writeResult?.[0]?.row_count ?? verification.length} rows).`);
}

main().catch((error) => {
  console.error(`Snapshot refresh failed: ${error.message}`);
  process.exitCode = 1;
});
