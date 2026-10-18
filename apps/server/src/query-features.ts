import type { QueryFeatures } from "@totalbase/query-engine";
import type { AppContext } from "./context.js";

/** The query language features Data API callers may use (api.allow_count, query.allow_*). */
export async function loadQueryFeatures(context: AppContext): Promise<QueryFeatures> {
  const [count, regex, contains, having] = await Promise.all([
    context.settings.get("api.allow_count"),
    context.settings.get("query.allow_regex"),
    context.settings.get("query.allow_contains"),
    context.settings.get("query.allow_having"),
  ]);
  return { count, regex, contains, having };
}
