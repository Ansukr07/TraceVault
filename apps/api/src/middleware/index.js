import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { z } from 'zod';
import { config } from '../config.js';
import { Case, ShareGrant, User } from '../models/index.js';
import { audit } from '../services/audit.js';

export const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Wrap async handlers so rejections reach the error handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const requireAuth = ah(async (req, _res, next) => {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) throw httpError(401, 'UNAUTHENTICATED', 'Missing token');
  let payload;
  try {
    payload = jwt.verify(h.slice(7), config.JWT_ACCESS_SECRET);
  } catch {
    throw httpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }
  const user = await User.findById(payload.sub).lean();
  if (!user || user.disabled) throw httpError(401, 'UNAUTHENTICATED', 'Invalid token');
  req.user = user;
  next();
});

/**
 * Loads :id (or :caseId) and checks membership. Non-members get 404, not 403,
 * so case IDs can't be probed. Role mismatch for a member is also 404-free: 403.
 */
export const requireCaseRole = (...roles) =>
  ah(async (req, _res, next) => {
    const id = req.params.id ?? req.params.caseId;
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'NOT_FOUND', 'Not found');
    const c = await Case.findOne({ _id: id, deletedAt: null, 'members.userId': req.user._id });
    if (!c) throw httpError(404, 'NOT_FOUND', 'Not found');
    const role = c.members.find((m) => String(m.userId) === String(req.user._id)).role;
    if (role === 'legal' || role === 'investigator') {
      // Shared access is time-limited and revocable: re-check the grant on every request.
      const grant = await ShareGrant.findOne({ caseId: c._id, acceptedBy: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } });
      if (!grant) throw httpError(404, 'NOT_FOUND', 'Not found');
      req.grant = grant;
      // Count a "view" at most once a minute so the owner sees real activity, not request noise.
      if (!grant.lastViewedAt || Date.now() - grant.lastViewedAt.getTime() > 60_000) {
        grant.viewCount += 1;
        grant.lastViewedAt = new Date();
        await grant.save();
        await audit(c._id, { actorId: req.user._id, actorRole: role, action: 'SHARED_CASE_VIEWED', target: String(grant._id) });
      }
    }
    if (roles.length && !roles.includes(role)) throw httpError(403, 'FORBIDDEN', 'Insufficient role');
    req.case = c;
    req.role = role;
    next();
  });

/** Gate a route to certain account types (admins always pass for `admin`). */
export const requireAccount = (...types) =>
  ah(async (req, _res, next) => {
    if (!types.includes(req.user.accountType ?? 'citizen')) throw httpError(403, 'FORBIDDEN', 'Not available for this account');
    next();
  });
export const requireAdmin = ah(async (req, _res, next) => {
  if (!req.user.isAdmin) throw httpError(403, 'FORBIDDEN', 'Admin only');
  next();
});

export const validate = (schema, part = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[part]);
  if (!r.success) return next(httpError(400, 'VALIDATION', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));
  req[part] = r.data;
  next();
};

export { z };

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  const status = err.status ?? (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: status >= 500 ? 'Internal error' : err.message } });
}
