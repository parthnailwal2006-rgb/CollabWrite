# Monitoring and Maintenance

`design.md` section 16 names the six numbers this project is evaluated on.
They are collected by `src/engine/metrics/Metrics.js`, written to
`metrics.log` as JSON lines, and summarised live at `GET /api/admin/stats`.

## 1. Metrics that matter

| Metric | Source | Healthy | Investigate above | What it means |
|--------|--------|---------|-------------------|---------------|
| Request waiting time | `scheduler.averageWaitingMs` | < 20 ms | 200 ms | Time from arrival to a worker picking it up. Rising means the worker pool is the bottleneck. |
| Transaction completion time | `transactions.averageCommitMs` | < 10 ms | 100 ms | BEGIN to COMMIT, including lock waits and the fsync. |
| Lock wait time | `locks.averageWaitMs` | < 5 ms | 50 ms | Contention. Sustained growth means too many editors on one document. |
| Buffer hit ratio | `bufferPool.hitRatio` | > 0.80 | < 0.50 | Below 0.5 the pool is thrashing; raise `ENGINE_BUFFER_FRAMES`. |
| Recovery time | `recovery.durationMs` | < 100 ms | 5000 ms | Grows with WAL length, because log truncation is not implemented. |
| Search latency | `search.latencyMs` | < 1 ms | 50 ms | An indexed lookup above this suggests the index was not rebuilt. |

Also worth watching:

| Signal | Source | Note |
|--------|--------|------|
| Deadlocks detected | `deadlock.deadlocksDetected` | Should stay at zero for the edit path, by construction |
| Lock timeouts | `locks.timeouts` | A non-zero value means something blocked longer than `LOCK_TIMEOUT_MS` |
| Aborted transactions | `transactions.aborted` | Mostly version conflicts; a spike means clients are not rebasing |
| Message queue depth | `messageQueue.buffered` | Sustained depth means consumers are slower than commits |
| Pages evicted | `bufferPool.evictions` | High with a low hit ratio confirms thrashing |

## 2. Reading metrics.log

One JSON object per line:

```json
{"ts":"2026-10-13T17:22:41.108Z","metric":"edit.latencyMs","value":4,"docId":7}
{"ts":"2026-10-13T17:22:41.330Z","metric":"search.latencyMs","value":0.0412,"keyword":"deadlock","useIndex":true}
```

```bash
# Mean edit latency
grep '"edit.latencyMs"' data/metrics.log \
  | jq -s 'map(.value) | add / length'

# Slowest ten edits
grep '"edit.latencyMs"' data/metrics.log | jq -s 'sort_by(-.value) | .[:10]'
```

A failed append is swallowed: metrics must never take the engine down.

## 3. Health and readiness

`GET /health` requires no authentication:

```json
{ "status": "ok", "documents": 3, "uptimeSeconds": 412 }
```

`status` is `starting` until crash recovery has completed, which is what the
Docker health check waits for. A container that reports healthy before
recovery finishes would be routed traffic that could read pages about to be
rolled back.

`GET /api/admin/stats` (admin only) returns every component's counters
including the lock table, the deadlock history and the recovery report.

## 4. Maintenance

### Checkpoints

```bash
curl -X POST localhost:3001/api/admin/checkpoint -H "Authorization: Bearer $ADMIN_TOKEN"
```

Flushes the buffer pool, fsyncs the data file and appends a CHECKPOINT
record. **Log truncation is not implemented** (`design.md` section 12 lists
it as a future improvement), so `wal.log` grows without bound and recovery
time grows with it. For a long-running deployment this is the first thing to
fix. Until then, the operational workaround is a planned restart with an
offline copy of `wal.log` taken afterwards.

### Backups

The three engine files must be backed up **together and consistently**:

```bash
docker compose stop backend          # quiesce: no writer, no partial state
docker run --rm -v collabwrite_enginedata:/data -v "$PWD:/backup" alpine \
  tar czf /backup/engine-$(date +%F).tar.gz -C /data .
pg_dump -U collabuser collabwrite > collabwrite-$(date +%F).sql
docker compose start backend
```

Copying `documents.dat` while the engine is running can capture a page
mid-write. The checksum would catch the corruption on restore, but the page
would still be lost, so quiescing first is not optional.

A PostgreSQL dump taken at a different time than the engine files is also a
hazard: metadata rows could reference documents the engine snapshot does not
contain. Take both within the same stop window.

### Capacity

| Resource | Grows with | Watch |
|----------|-----------|-------|
| `documents.dat` | Total text; pages are never reclaimed after a delete | Disk |
| `wal.log` | Every write, with two 4 KiB page images per UPDATE | Disk, and recovery time |
| `index.dat` | Distinct keywords | Negligible |
| Buffer pool | Fixed at `ENGINE_BUFFER_FRAMES * 4 KiB` | Nothing |
| Lock table | Active transactions; entries are pruned when empty | Nothing |

`wal.log` is the one to watch: roughly 8 KiB per page write. A busy document
can produce tens of megabytes per hour.

## 5. Tuning

| Symptom | Likely cause | Change |
|---------|--------------|--------|
| Buffer hit ratio below 0.5 | Working set exceeds the pool | Raise `ENGINE_BUFFER_FRAMES` |
| High waiting time, low lock wait | Too few workers | Raise `ENGINE_WORKERS` |
| High lock wait time | Many editors on one document | Expected: edits to one document serialise by design |
| One document starving others | FIFO convoy effect | `SCHEDULER_POLICY=ROUND_ROBIN` |
| Slow commits | fsync cost | Keep `WAL_SYNC_ON_COMMIT=true` in production; durability is the point |
| Lock timeouts under load | `LOCK_TIMEOUT_MS` too low | Raise it, or lower `DEADLOCK_CHECK_INTERVAL_MS` so cycles break sooner |

## 6. Troubleshooting

**`PageCorruptionError` on startup.** A page failed its CRC-32. The data file
is damaged; restore from backup. The checksum did its job — it stopped a bad
page from being served as good.

**Recovery reports many losers.** Normal after a crash under load: every
in-flight transaction is a loser. A large `undone` count simply means the
buffer pool had stolen a lot.

**Edits return 409 repeatedly.** Two clients are editing the same region.
Expected behaviour; the React client rebases automatically.

**Edits return 503 `ENGINE_SATURATED`.** Every buffer frame is pinned. This
means more concurrent transactions than frames — raise
`ENGINE_BUFFER_FRAMES` above `ENGINE_WORKERS` by a comfortable margin.

**Search returns nothing after a restart.** The index rebuilds from the data
files at start-up; check the logs for a `reindexAll` failure.
