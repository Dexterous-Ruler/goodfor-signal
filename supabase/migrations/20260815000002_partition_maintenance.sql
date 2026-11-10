-- ============================================================================
-- Partition maintenance.
--
-- If video_metric_snapshot runs out of future partitions, INSERTs fail with
-- "no partition of relation found for row" — the poller stops silently
-- recording data while appearing healthy. This keeps 3 months of runway
-- ahead at all times.
-- ============================================================================

create extension if not exists pg_cron;

-- Runs 03:00 UTC on the 1st of each month. Idempotent by construction.
select cron.schedule(
  'ensure-metric-partitions',
  '0 3 1 * *',
  $$select ensure_metric_partitions(3)$$
);
