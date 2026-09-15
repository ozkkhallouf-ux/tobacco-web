import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SALES_SYNC_MAX_AGE_MINUTES,
  assertTrustedSalesInput,
  getSingleSalesSyncMarker,
  resolveDefaultSnapshotWindowEnd,
} from './item-snapshot-freshness.mjs';
import { getSalesWindow } from './item-snapshot-pipeline.mjs';

const now = new Date('2026-08-19T01:10:00.000Z');
const snapshotWindow = { start: '2026-07-20', end: '2026-08-19' };
const marker = {
  source: 'ameen_sales_line_items',
  sync_run_id: 'afc6e476-01d6-4332-88d9-b2cfe6fcdb23',
  window_start: '2026-07-20',
  window_end: '2026-08-19',
  row_count: 3,
  completed_at: '2026-08-19T00:45:00.000Z',
};
const salesRows = [
  { sale_date: '2026-07-25', source_key: '00000000-0000-4000-8000-000000000003' },
  { sale_date: '2026-08-12', source_key: '00000000-0000-4000-8000-000000000001' },
  { sale_date: '2026-08-19', source_key: '00000000-0000-4000-8000-000000000002' },
];

// A. A fresh, complete marker permits an applyable input set.
const trusted = assertTrustedSalesInput({
  markerBefore: marker, markerAfter: { ...marker }, salesLineItems: salesRows,
  snapshotWindow, now,
});
assert.equal(trusted.rowCount, 3);
assert.equal(SALES_SYNC_MAX_AGE_MINUTES, 75);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, source: 'wrong_source' },
  markerAfter: { ...marker, source: 'wrong_source' },
  salesLineItems: salesRows, snapshotWindow, now,
}), /unexpected marker source/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, sync_run_id: 'not-a-uuid' },
  markerAfter: { ...marker, sync_run_id: 'not-a-uuid' },
  salesLineItems: salesRows, snapshotWindow, now,
}), /sync_run_id is not a valid UUID/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, completed_at: null },
  markerAfter: { ...marker, completed_at: null },
  salesLineItems: salesRows, snapshotWindow, now,
}), /completed_at is missing or invalid/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, row_count: -1 }, markerAfter: { ...marker, row_count: -1 },
  salesLineItems: salesRows, snapshotWindow, now,
}), /row_count must be a non-negative integer/);

// B. Missing marker is fail-closed.
assert.throws(() => getSingleSalesSyncMarker([]), /completion marker is missing/);

// C. One missed 30-minute run, the next cadence, and its 15-minute execution allowance totals 75 minutes.
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, completed_at: '2026-08-18T23:54:59.000Z' },
  markerAfter: { ...marker, completed_at: '2026-08-18T23:54:59.000Z' },
  salesLineItems: salesRows, snapshotWindow, now,
}), /completion marker is stale/);

// D. Only an exact D-30..D generation proves the full consumer window.
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, window_start: '2026-08-12', row_count: 2 },
  markerAfter: { ...marker, window_start: '2026-08-12', row_count: 2 },
  salesLineItems: salesRows, snapshotWindow, now,
}), /must exactly match the full snapshot window/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, window_end: '2026-08-18' },
  markerAfter: { ...marker, window_end: '2026-08-18' },
  salesLineItems: salesRows, snapshotWindow, now,
}), /must exactly match the full snapshot window/);

// D2. Midnight race: default today may rebase to a fresh yesterday sealed marker.
const midnightNow = new Date('2026-08-19T00:30:00.000Z');
const yesterdayMarker = {
  ...marker,
  window_start: '2026-07-19',
  window_end: '2026-08-18',
  completed_at: '2026-08-18T23:50:00.000Z',
};
const rebased = resolveDefaultSnapshotWindowEnd({
  requestedWindowEnd: '2026-08-19',
  windowEndWasExplicit: false,
  marker: yesterdayMarker,
  now: midnightNow,
  getSalesWindow,
});
assert.equal(rebased.windowEnd, '2026-08-18');
assert.equal(rebased.rebased, true);
const explicitKept = resolveDefaultSnapshotWindowEnd({
  requestedWindowEnd: '2026-08-19',
  windowEndWasExplicit: true,
  marker: yesterdayMarker,
  now: midnightNow,
  getSalesWindow,
});
assert.equal(explicitKept.windowEnd, '2026-08-19');
assert.equal(explicitKept.rebased, false);
const staleYesterday = resolveDefaultSnapshotWindowEnd({
  requestedWindowEnd: '2026-08-19',
  windowEndWasExplicit: false,
  marker: { ...yesterdayMarker, completed_at: '2026-08-18T22:00:00.000Z' },
  now: midnightNow,
  getSalesWindow,
});
assert.equal(staleYesterday.rebased, false);
assert.equal(staleYesterday.windowEnd, '2026-08-19');

// The producer can replace wider history, so the guard never treats older rows as immutable.
const salesProducer = await readFile('tools/push-sales-line-items.ps1', 'utf8');
assert.match(salesProducer, /\[ValidateRange\(1, 31\)\]\[int\]\$Days = 7/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, window_start: '2026-08-05' },
  markerAfter: { ...marker, window_start: '2026-08-05' },
  salesLineItems: salesRows, snapshotWindow, now,
}), /must exactly match the full snapshot window/);

// E. The committed marker count must match actual rows in the marker window.
assert.throws(() => assertTrustedSalesInput({
  markerBefore: { ...marker, row_count: 4 }, markerAfter: { ...marker, row_count: 4 },
  salesLineItems: salesRows, snapshotWindow, now,
}), /marker row_count is 4, but 3 rows were read/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: marker, markerAfter: marker,
  salesLineItems: [{ ...salesRows[0], source_key: null }, ...salesRows.slice(1)], snapshotWindow, now,
}), /missing or invalid source_key/);
assert.throws(() => assertTrustedSalesInput({
  markerBefore: marker, markerAfter: marker,
  salesLineItems: [salesRows[0], { ...salesRows[1], source_key: salesRows[0].source_key }, salesRows[2]],
  snapshotWindow, now,
}), /duplicate source_key/);

// F. A sales commit during pagination changes sync_run_id and blocks the snapshot.
assert.throws(() => assertTrustedSalesInput({
  markerBefore: marker,
  markerAfter: { ...marker, sync_run_id: '00000000-0000-4000-8000-000000000099' },
  salesLineItems: salesRows, snapshotWindow, now,
}), /completion marker changed during sales reads/);

// G. Dry-run and Apply share the same guard, before either branch can report output/write.
const producer = await readFile('scripts/refresh-ameen-item-snapshot.mjs', 'utf8');
const guardIndex = producer.indexOf('const trustedSalesSync = assertTrustedSalesInput');
const dryRunIndex = producer.indexOf('if (!apply)');
const rpcIndex = producer.indexOf('/rest/v1/rpc/replace_ameen_item_snapshot');
assert.ok(guardIndex >= 0 && guardIndex < dryRunIndex, 'freshness guard must run before Dry Run returns');
assert.ok(guardIndex < rpcIndex, 'freshness guard must run before the snapshot RPC');
assert.doesNotMatch(producer, /max\s*\(\s*created_at\s*\)/i);
assert.match(producer, /p_snapshot_window_start:\s*result\.window\.start/);
assert.match(producer, /p_snapshot_window_end:\s*result\.window\.end/);
assert.match(producer, /p_expected_sales_generation:\s*\{/);
assert.match(producer, /resolveDefaultSnapshotWindowEnd/,
  'producer must rebase default window_end onto a fresh yesterday sales marker after midnight');

console.log('Item snapshot freshness guard contract checks passed.');
