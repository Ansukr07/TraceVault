import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { AppShell, PageHead } from '../../ui';

export function OfficerProfilePage() {
  const { user } = useAuth();
  const officer = user?.officer;

  return (
    <AppShell>
      <PageHead
        eyebrow="Police Credentials (§7.4)"
        title={<>Officer profile <span className="muted">& service credentials</span></>}
      />

      <div className="split" style={{ alignItems: 'start' }}>
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Badge & department details</h3>
            <span className={`badge ${officer?.verified ? 'ok' : 'warn'}`}>
              {officer?.verified ? 'Verified Police Officer' : 'Pending Verification'}
            </span>
          </div>

          <div className="kv" style={{ fontSize: 14 }}>
            <dt>Full Name</dt>
            <dd>{user?.name}</dd>
            <dt>Official Email</dt>
            <dd className="mono">{user?.email}</dd>
            <dt>Agency / Dept</dt>
            <dd>{officer?.agency || 'Not set'}</dd>
            <dt>Station / Unit</dt>
            <dd>{officer?.unit || 'Not set'}</dd>
            <dt>Rank / Designation</dt>
            <dd>{officer?.rank || 'Not specified'}</dd>
            <dt>Badge / ID</dt>
            <dd className="mono">{officer?.badgeId || 'Not set'}</dd>
            <dt>Verification Status</dt>
            <dd>{officer?.verified ? 'Verified by platform administrator' : 'Under admin review'}</dd>
          </div>
        </section>

        <section className="card stack" style={{ gap: 14 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Evidentiary standards & rules</h3>
          </div>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Under Section 63 BSA, all digital evidence examined via this console maintains complete chain-of-custody hashes. Every case overview, timeline inspection, and transcript preview you load generates an immutable audit record visible to the complainant.
          </p>
          <div className="card" style={{ background: 'var(--paper-2)', padding: 12, fontSize: 12 }}>
            <strong>Watermarking:</strong> Every view of an evidence file or report export is watermarked with your official email address ({user?.email}) and an immutable timestamp.
          </div>
        </section>
      </div>
    </AppShell>
  );
}
