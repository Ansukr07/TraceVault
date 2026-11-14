/**
 * One-click demo login. The demo account is created by `npm run seed:demo`
 * (scripts/seed-demo.js). Enabled in dev, or in a build with VITE_DEMO_LOGIN=true;
 * credentials can be overridden with VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD.
 * Never enable this against a database holding real cases.
 */
const env = (import.meta as unknown as { env: Record<string, string | boolean | undefined> }).env;

export const DEMO: { email: string; password: string } | null =
  env.DEV || env.VITE_DEMO_LOGIN === 'true'
    ? {
        email: String(env.VITE_DEMO_EMAIL ?? 'priya.demo@tracevault.test'),
        password: String(env.VITE_DEMO_PASSWORD ?? 'tracevault-demo-password'),
      }
    : null;
