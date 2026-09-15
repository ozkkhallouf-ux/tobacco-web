export const SALES_SYNC_SOURCE = 'ameen_sales_line_items';
export const SALES_SYNC_CADENCE_MINUTES = 30;
// One fully missed 30-minute run, then the next cadence plus its 15-minute execution allowance.
export const SALES_SYNC_MAX_AGE_MINUTES = 75;
const MAX_FUTURE_SKEW_MINUTES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(reason) {
  throw new Error(`sales freshness guard failed: ${reason}`);
}

function dateOnly(value, label) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(`${label} is not a valid date`);
  }
  return text;
}

export function getSingleSalesSyncMarker(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail(rows?.length ? `expected one ${SALES_SYNC_SOURCE} marker, received ${rows.length}` : 'completion marker is missing');
  }
  return rows[0];
}

export function validateSalesSyncMarker(marker, snapshotWindow, {
  now = new Date(),
  maxAgeMinutes = SALES_SYNC_MAX_AGE_MINUTES,
} = {}) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) fail('completion marker is missing');
  if (marker.source !== SALES_SYNC_SOURCE) fail(`unexpected marker source: ${marker.source ?? '<missing>'}`);
  if (!UUID_PATTERN.test(String(marker.sync_run_id ?? ''))) fail('sync_run_id is not a valid UUID');

  const completedAtText = String(marker.completed_at ?? '').trim();
  if (!completedAtText) fail('completed_at is missing or invalid');
  const completedAt = new Date(completedAtText);
  const checkedAt = new Date(now);
  if (!Number.isFinite(completedAt.getTime())) fail('completed_at is missing or invalid');
  if (!Number.isFinite(checkedAt.getTime())) fail('guard clock is invalid');
  const ageMs = checkedAt.getTime() - completedAt.getTime();
  if (ageMs < -(MAX_FUTURE_SKEW_MINUTES * 60_000)) fail('completed_at is unexpectedly in the future');
  if (ageMs > maxAgeMinutes * 60_000) {
    fail(`completion marker is stale (${Math.floor(ageMs / 60_000)} minutes old; maximum ${maxAgeMinutes})`);
  }

  const rowCount = Number(marker.row_count);
  if (!Number.isInteger(rowCount) || rowCount < 0) fail('row_count must be a non-negative integer');
  const markerStart = dateOnly(marker.window_start, 'marker.window_start');
  const markerEnd = dateOnly(marker.window_end, 'marker.window_end');
  if (markerEnd < markerStart) fail('marker window is inverted');

  const snapshotStart = dateOnly(snapshotWindow?.start, 'snapshot.window_start');
  const snapshotEnd = dateOnly(snapshotWindow?.end, 'snapshot.window_end');
  if (snapshotEnd < snapshotStart) fail('snapshot window is inverted');
  if (markerStart !== snapshotStart || markerEnd !== snapshotEnd) {
    fail(`marker window ${markerStart}..${markerEnd} must exactly match the full snapshot window ${snapshotStart}..${snapshotEnd}`);
  }

  return {
    source: marker.source,
    syncRunId: String(marker.sync_run_id).toLowerCase(),
    windowStart: markerStart,
    windowEnd: markerEnd,
    rowCount,
    completedAt: completedAtText,
  };
}

export function validateSalesRowsAgainstMarker(salesLineItems, marker) {
  if (!Array.isArray(salesLineItems)) fail('sales rows are unavailable');
  const markerRows = salesLineItems.filter((row) => {
    const saleDate = dateOnly(row.sale_date, 'sales_line_items.sale_date');
    return saleDate >= marker.windowStart && saleDate <= marker.windowEnd;
  });
  if (markerRows.length !== marker.rowCount) {
    fail(`marker row_count is ${marker.rowCount}, but ${markerRows.length} rows were read from its window`);
  }

  const sourceKeys = new Set();
  for (const row of markerRows) {
    const sourceKey = String(row.source_key ?? '').trim().toLowerCase();
    if (!UUID_PATTERN.test(sourceKey)) fail('marker-window row has a missing or invalid source_key');
    if (sourceKeys.has(sourceKey)) fail(`duplicate source_key in marker window: ${sourceKey}`);
    sourceKeys.add(sourceKey);
  }
  return markerRows.length;
}

export function assertStableSalesSync(before, after) {
  for (const field of ['source', 'syncRunId', 'windowStart', 'windowEnd', 'rowCount', 'completedAt']) {
    if (before[field] !== after[field]) fail(`completion marker changed during sales reads (${field})`);
  }
}

export function assertTrustedSalesInput({ markerBefore, markerAfter, salesLineItems,
  snapshotWindow, now = new Date() }) {
  const before = validateSalesSyncMarker(markerBefore, snapshotWindow, { now });
  validateSalesRowsAgainstMarker(salesLineItems, before);
  const after = validateSalesSyncMarker(markerAfter, snapshotWindow, { now });
  assertStableSalesSync(before, after);
  return before;
}

/**
 * After local midnight the snapshot defaults to today's window_end, but the
 * sales sync task (every 30 minutes) may still hold yesterday's sealed marker
 * until its first post-midnight run. Aligning to that fresh yesterday marker
 * avoids a phantom Telegram alert at the near-midnight hourly snapshot slot.
 * Explicit --window-end= is never rewritten.
 */
export function resolveDefaultSnapshotWindowEnd({
  requestedWindowEnd,
  windowEndWasExplicit,
  marker,
  now = new Date(),
  getSalesWindow,
}) {
  if (windowEndWasExplicit || !marker || typeof marker !== 'object') {
    return { windowEnd: requestedWindowEnd, rebased: false };
  }
  const markerEnd = String(marker.window_end ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(markerEnd) || markerEnd === requestedWindowEnd) {
    return { windowEnd: requestedWindowEnd, rebased: false };
  }
  const requested = new Date(`${requestedWindowEnd}T00:00:00`);
  const markerDay = new Date(`${markerEnd}T00:00:00`);
  if (!Number.isFinite(requested.getTime()) || !Number.isFinite(markerDay.getTime())) {
    return { windowEnd: requestedWindowEnd, rebased: false };
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (requested.getTime() - markerDay.getTime() !== dayMs) {
    return { windowEnd: requestedWindowEnd, rebased: false };
  }
  if (typeof getSalesWindow !== 'function') {
    return { windowEnd: requestedWindowEnd, rebased: false };
  }
  try {
    const provisional = getSalesWindow(markerEnd, 30);
    validateSalesSyncMarker(marker, provisional, { now });
    return { windowEnd: markerEnd, rebased: true };
  } catch {
    return { windowEnd: requestedWindowEnd, rebased: false };
  }
}
