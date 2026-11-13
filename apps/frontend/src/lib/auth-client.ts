import { createAuthClient } from 'better-auth/react';
import { API_URL, apiOrigin } from './config';

export const authClient = createAuthClient({
  baseURL: apiOrigin,
});

/** Ends the Google session and the local dev session (if any), then returns to the login page. */
export async function signOutEverywhere() {
  await fetch(`${API_URL}/api/dev/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
  await authClient.signOut().catch(() => undefined);
  window.location.assign(`${import.meta.env.BASE_URL}login`);
}
