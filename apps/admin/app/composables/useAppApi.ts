/**
 * Client for the application UI's own server routes (`/app/api/*` - any
 * portal user, admin or app access): published DataViews/dashboards and
 * My account (`/app/api/me/*`). The Admin API client's shape over another
 * route family.
 */
export function useAppApi() {
  return createSessionApi('/app/api')
}
