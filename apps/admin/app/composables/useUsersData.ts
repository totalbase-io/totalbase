/**
 * Every cached view of the users list - the full list some pickers load
 * (`users`), the Users table's current page (`users-page`) and the Users
 * panel's counts (`users-summary`). Refresh them together after a user is
 * created, edited, deleted or has its roles changed.
 */
export const USERS_DATA_KEYS = ['users', 'users-page', 'users-summary']

export function refreshUsersData(): Promise<void> {
  return refreshNuxtData(USERS_DATA_KEYS)
}
