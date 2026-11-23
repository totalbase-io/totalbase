-- A role for widget SQL (Dashboards.md §2.10): with `dashboards.query_role` set, a dashboard widget's query runs
-- inside this function, which TotalBase hands to that role (ALTER FUNCTION ... OWNER TO, when the setting is first
-- used). SECURITY DEFINER runs it with its owner's privileges, and PostgreSQL refuses to change `role` inside a
-- security-definer function - so `set_config('role', 'none', true)` in the query can't return to TotalBase's own,
-- the escape a `SET LOCAL ROLE` would leave open. `expected` is the role the caller means: a function whose owner
-- isn't it (reassigned by hand, a restore with --no-owner) refuses to run rather than run as someone else.
-- Until then it belongs to TotalBase's role, and nothing calls it.
CREATE FUNCTION totalbase.dashboards_query(query text, params text[], expected name) RETURNS SETOF record
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
BEGIN
  IF current_user <> expected THEN
    RAISE EXCEPTION 'totalbase.dashboards_query belongs to %, not to %', current_user, expected USING ERRCODE = 'TB001';
  END IF;
  RETURN QUERY EXECUTE query USING params;
END;
$$;

COMMENT ON FUNCTION totalbase.dashboards_query(text, text[], name) IS 'Runs a dashboard widget''s query as its owner, the role named by dashboards.query_role - which the query can''t leave.';

REVOKE ALL ON FUNCTION totalbase.dashboards_query(text, text[], name) FROM PUBLIC;
