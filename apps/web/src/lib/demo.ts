/**
 * One-click demo logins, one per role. Accounts come from `npm run seed:demo` (complainant) and
 * `npm run seed:roles` (lawyer, officer, official, admin). Enabled in dev, or in a build with
 * VITE_DEMO_LOGIN=true; the shared password can be overridden with VITE_DEMO_PASSWORD.
 * Never enable this against a database holding real cases.
 */
const env = (import.meta as unknown as { env: Record<string, string | boolean | undefined> }).env;
const enabled = !!(env.DEV || env.VITE_DEMO_LOGIN === 'true');
const password = String(env.VITE_DEMO_PASSWORD ?? 'tracevault-demo-password');

export type DemoAccount = { key: string; label: string; hint: string; email: string; password: string; home: string; seed: 'seed:demo' | 'seed:roles' };

export const DEMOS: DemoAccount[] | null = enabled
  ? [
      { key: 'citizen', label: 'Complainant', hint: 'Owns cases, uploads evidence, shares', email: String(env.VITE_DEMO_EMAIL ?? 'priya.demo@tracevault.test'), password, home: '/cases', seed: 'seed:demo' },
      { key: 'legal', label: 'Lawyer', hint: 'Cases shared for a limited time', email: 'lawyer.demo@tracevault.test', password, home: '/legal', seed: 'seed:roles' },
      { key: 'officer', label: 'Police officer', hint: 'Inbox, case actions, FIR status', email: 'officer.demo@tracevault.test', password, home: '/officer', seed: 'seed:roles' },
      { key: 'official', label: 'Government official', hint: 'Aggregate oversight dashboard', email: 'official.demo@tracevault.test', password, home: '/oversight', seed: 'seed:roles' },
      { key: 'admin', label: 'Platform admin', hint: 'Users, officer approvals, jobs', email: 'admin.demo@tracevault.test', password, home: '/admin', seed: 'seed:roles' },
    ]
  : null;

/** The complainant demo, used by the "Try demo" shortcut in the nav bar. */
export const DEMO: { email: string; password: string } | null = DEMOS ? { email: DEMOS[0].email, password: DEMOS[0].password } : null;
