-- Fix auth_rls_initplan performance lint on public.ameen_read_requests.
-- current_setting('app.settings.ameen_sync_email', true) was being
-- re-evaluated per row inside the SELECT/UPDATE RLS policies; wrapping it
-- in a scalar subquery lets Postgres evaluate it once as an InitPlan.
-- No change to access conditions, roles, or grants.

alter policy "ameen_read_worker_select" on public.ameen_read_requests
  using (
    ((select auth.uid()) = requested_by)
    or (
      lower(coalesce(((select auth.jwt()) ->> 'email'::text), ''::text))
      = lower(coalesce((select current_setting('app.settings.ameen_sync_email'::text, true)), ''::text))
    )
  );

alter policy "ameen_read_worker_update" on public.ameen_read_requests
  using (
    lower(coalesce(((select auth.jwt()) ->> 'email'::text), ''::text))
    = lower(coalesce((select current_setting('app.settings.ameen_sync_email'::text, true)), ''::text))
  )
  with check (
    lower(coalesce(((select auth.jwt()) ->> 'email'::text), ''::text))
    = lower(coalesce((select current_setting('app.settings.ameen_sync_email'::text, true)), ''::text))
  );
