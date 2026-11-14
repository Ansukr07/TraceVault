import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { post, restoreSession, setToken, type User } from './api';

type Ctx = {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, name: string, password: string, extra?: { accountType?: 'citizen' | 'officer'; officer?: { agency: string; unit: string; rank?: string; badgeId: string } }) => Promise<User>;
  logout: () => Promise<void>;
};
const AuthCtx = createContext<Ctx>(null!);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    restoreSession().then(setUser).catch(() => setUser(null)).finally(() => setReady(true));
  }, []);

  const finish = (r: { accessToken: string; user: User }) => {
    setToken(r.accessToken);
    setUser(r.user);
    return r.user;
  };
  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        login: async (email, password) => finish(await post('/auth/login', { email, password })),
        register: async (email, name, password, extra) => finish(await post('/auth/register', { email, name, password, ...extra })),
        logout: async () => { await post('/auth/logout').catch(() => {}); setToken(null); setUser(null); },
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
