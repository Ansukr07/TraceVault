// Share-grant access and evidence scope (spec H1–H5, §2).
// Owners and collaborators see everything. Legal/investigator members only see what an active grant allows:
// the grant must be accepted by them, unrevoked and unexpired, and may list specific evidence ids.
import { Evidence, ShareGrant } from '../models/index.js';
import { audit } from './audit.js';

export const isShared = (role) => role === 'legal' || role === 'investigator';

/** Active grant for a shared member, or null (the caller answers 404 so access can't be probed). */
export async function activeGrant(caseId, userId) {
  return ShareGrant.findOne({ caseId, acceptedBy: userId, revokedAt: null, expiresAt: { $gt: new Date() } });
}

/**
 * Evidence visible to this request: { ids:Set<string>, idx:Set<number> } or null for unrestricted access.
 * Children of an allowed archive/email stay hidden unless listed: scope is explicit.
 */
export async function scopeFor(req) {
  const g = req.grant;
  if (!isShared(req.role) || !g || g.scope?.type !== 'evidence') return null;
  const ids = new Set((g.scope.evidenceIds ?? []).map(String));
  const docs = await Evidence.find({ _id: { $in: [...ids] } }, 'idx').lean();
  return { ids, idx: new Set(docs.map((d) => d.idx)) };
}

/** Mongo filter fragment restricting an `evidenceId`-style field. */
export const evidenceFilter = (scope, field = 'evidenceId') => (scope ? { [field]: { $in: [...scope.ids] } } : {});

/** "E3:12" / "E3" → allowed? */
export function citationAllowed(scope, cid) {
  if (!scope) return true;
  const m = /^E(\d+)(?::\d+)?$/.exec(cid);
  return !!m && scope.idx.has(Number(m[1]));
}

/** Replace out-of-scope citations with a visible RESTRICTED marker (H3). */
export function restrictCitations(scope, cites = []) {
  if (!scope) return cites;
  const kept = cites.filter((c) => citationAllowed(scope, c));
  return kept.length === cites.length ? kept : [...kept, 'RESTRICTED'];
}

export const evidenceAllowed = (scope, id) => !scope || scope.ids.has(String(id));

/** Resolve the grant for a request that did not go through requireCaseRole (e.g. /evidence/:eid). */
export async function resolveAccess(c, user) {
  const role = c.members.find((m) => String(m.userId) === String(user._id))?.role;
  if (!role) return null;
  if (!isShared(role)) return { role, grant: null };
  const grant = await activeGrant(c._id, user._id);
  if (!grant) return null;
  return { role, grant };
}

export async function logSharedView(caseId, user, role, grant) {
  if (!grant.lastViewedAt || Date.now() - grant.lastViewedAt.getTime() > 60_000) {
    grant.viewCount += 1;
    grant.lastViewedAt = new Date();
    await grant.save();
    await audit(caseId, { actorId: user._id, actorRole: role, action: 'SHARED_CASE_VIEWED', target: String(grant._id) });
  }
}

export const viewerStamp = (user, caseId) => `Viewed by ${user.email} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · Case ${caseId}`;
