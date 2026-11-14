import React, { Suspense, lazy } from 'react';
const GraphPage = lazy(() => import('./pages/case/Graph').then((m) => ({ default: m.GraphPage })));
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { homeFor } from './lib/roles';
import type { User } from './lib/api';
import { AuthPage } from './pages/AuthPages';
import { CasesPage, NewCasePage } from './pages/CasePages';
import { Landing } from './pages/Landing';
import { UploadPage } from './pages/UploadPage';
import { OverviewPage } from './pages/case/Overview';
import { EvidenceLibraryPage } from './pages/case/EvidenceLibrary';
import { ViewerPage } from './pages/case/Viewer';
import { TimelinePage } from './pages/case/Timeline';
import { InconsistenciesPage } from './pages/case/Inconsistencies';
import { SummaryPage } from './pages/case/Summary';
import { InsightsPage } from './pages/case/Insights';
import { AuditPage } from './pages/case/Audit';
import { SettingsPage } from './pages/case/Settings';
import { SharePage } from './pages/case/SharePage';
import { ExportPage } from './pages/case/ExportPage';
import { ComplaintPage } from './pages/case/Complaint';
import { SafetyBar } from './features';
import { VoiceStatementPage } from './pages/case/VoiceStatementPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { VerifyBundlePage } from './pages/VerifyBundlePage';
import { OfficerInboxPage } from './pages/officer/OfficerInboxPage';
import { OfficerProfilePage } from './pages/officer/OfficerProfilePage';
import { OversightDashboardPage } from './pages/oversight/OversightDashboardPage';
import { AdminPage } from './pages/admin/AdminPage';
import { AccountPage } from './pages/AccountPage';
import { SharedWithMePage } from './pages/legal/SharedWithMePage';
import './styles.css';
import './app.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** Catches render errors so one bad page never leaves a blank white screen. Resets when the route changes. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  componentDidCatch(error: Error) { console.error('Page crashed:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="wrap page">
        <h2>Something went wrong on this page</h2>
        <p className="muted">{this.state.error.message}</p>
        <button type="button" className="btn btn-dark" onClick={() => this.setState({ error: null })}>Try again</button>{' '}
        <button type="button" className="btn btn-light" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}
/** Quick exit + discreet mode on every signed-in page (future spec F5). */
function SafetyWhenSignedIn() {
  const { user } = useAuth();
  return <SafetyBar signedIn={!!user} />;
}
function Guarded({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

/** Signed-in only. `allow` narrows it to certain accounts; others are sent to their own home (never shown an error page). */
function Private({ children, allow }: { children: React.ReactElement; allow?: (u: User) => boolean }) {
  const { user, ready } = useAuth();
  const here = useLocation();
  if (!ready) return <main className="wrap page"><p className="muted">Loading…</p></main>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(here.pathname + here.search)}`} replace />;
  if (allow && !allow(user)) return <Navigate to={homeFor(user)} replace />;
  return children;
}
const onlyOfficer = (u: User) => u.accountType === 'officer';
const onlyOversight = (u: User) => u.accountType === 'official' || u.isAdmin;
const onlyAdmin = (u: User) => u.isAdmin;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Guarded><Routes>
            {/* 3.1 Public */}
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/share/accept" element={<AcceptInvitePage />} />
            <Route path="/verify" element={<VerifyBundlePage />} />

            {/* 3.2 Complainant & Case workspace */}
            <Route path="/cases" element={<Private><CasesPage /></Private>} />
            <Route path="/cases/new" element={<Private><NewCasePage /></Private>} />
            <Route path="/cases/:id" element={<Private><OverviewPage /></Private>} />
            <Route path="/cases/:id/evidence" element={<Private><EvidenceLibraryPage /></Private>} />
            <Route path="/cases/:id/evidence/:eid" element={<Private><ViewerPage /></Private>} />
            <Route path="/cases/:id/timeline" element={<Private><TimelinePage /></Private>} />
            <Route path="/cases/:id/graph" element={<Private><Suspense fallback={<p className="wrap page muted">Loading graph…</p>}><GraphPage /></Suspense></Private>} />
            <Route path="/cases/:id/inconsistencies" element={<Private><InconsistenciesPage /></Private>} />
            <Route path="/cases/:id/summary" element={<Private><SummaryPage /></Private>} />
            <Route path="/cases/:id/insights" element={<Private><InsightsPage /></Private>} />
            <Route path="/cases/:id/audit" element={<Private><AuditPage /></Private>} />
            <Route path="/cases/:id/settings" element={<Private><SettingsPage /></Private>} />
            <Route path="/cases/:id/upload" element={<Private><UploadPage /></Private>} />
            <Route path="/cases/:id/share" element={<Private><SharePage /></Private>} />
            <Route path="/cases/:id/export" element={<Private><ExportPage /></Private>} />
            <Route path="/cases/:id/complaint" element={<Private><ComplaintPage /></Private>} />
            <Route path="/cases/:id/statement" element={<Private><VoiceStatementPage /></Private>} />
            <Route path="/legal" element={<Private><SharedWithMePage /></Private>} />
            <Route path="/account" element={<Private><AccountPage /></Private>} />

            {/* 3.3 Officer Console */}
            <Route path="/officer" element={<Private><OfficerInboxPage /></Private>} />
            <Route path="/officer/verify" element={<Private><VerifyBundlePage /></Private>} />
            <Route path="/officer/profile" element={<Private allow={onlyOfficer}><OfficerProfilePage /></Private>} />

            {/* 3.4 Oversight & Platform Admin */}
            <Route path="/oversight" element={<Private allow={onlyOversight}><OversightDashboardPage /></Private>} />
            <Route path="/admin" element={<Private allow={onlyAdmin}><AdminPage /></Private>} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Guarded>
          <SafetyWhenSignedIn />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
