// The app's own public address. Set BETTER_AUTH_URL / WEB_ORIGIN yourself, or on Render it is found
// automatically (RENDER_EXTERNAL_URL), so a fresh deploy needs no extra step.
const fallback = 'http://localhost:5173';

export const authBaseUrl = () => process.env.BETTER_AUTH_URL || process.env.RENDER_EXTERNAL_URL || undefined;
export const webOrigin = () => process.env.WEB_ORIGIN || process.env.RENDER_EXTERNAL_URL || fallback;
