import type { User } from './api';

/** Where each kind of account lands after signing in (frontend-plan §3 / Auth). */
export function homeFor(u?: Pick<User, 'accountType' | 'isAdmin'> | null): string {
  if (!u) return '/';
  if (u.isAdmin) return '/admin';
  if (u.accountType === 'officer') return '/officer';
  if (u.accountType === 'official') return '/oversight';
  return '/cases';
}
