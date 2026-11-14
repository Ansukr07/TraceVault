import React, { Suspense, lazy } from 'react';
const GraphPage = lazy(() => import('./pages/case/Graph').then((m) => ({ default: m.GraphPage })));
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
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
import './styles.css';
import './app.css';

const qc = new QueryClient();

function Private({ children }: { children: React.ReactElement }) {
  const { user, ready } = useAuth();
  if (!ready) return <main className="wrap page"><p className="muted">Loading…</p></main>;
  return user ? children : <Navigate to="/login" replace />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
