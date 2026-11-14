import crypto from 'node:crypto';
import { Router } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { RefreshToken, User } from '../models/index.js';
import { ah, httpError, requireAuth, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { sha256Hex } from '../services/crypto.js';

export const authRouter = Router();

const REFRESH_DAYS = 30;
const COOKIE = 'tv_refresh';

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true, // only failed attempts count
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, try later' } }),
});

const signAccess = (user) => jwt.sign({ sub: String(user._id) }, config.JWT_ACCESS_SECRET, { expiresIn: '15m' });

const publicUser = (u) => ({
  id: String(u._id),
  email: u.email,
  name: u.name,
  isAdmin: u.isAdmin,
  accountType: u.accountType ?? 'citizen',
  officer: u.officer?.agency ? { agency: u.officer.agency, unit: u.officer.unit, rank: u.officer.rank, badgeId: u.officer.badgeId, verified: !!u.officer.verifiedAt, rejected: !!u.officer.rejectedAt } : undefined,
  uiLanguage: u.uiLanguage,
  voiceLanguage: u.voiceLanguage,
});

async function issueRefresh(res, userId, familyId = crypto.randomUUID()) {
  const token = crypto.randomBytes(32).toString('base64url');
  await RefreshToken.create({
    userId,
    familyId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000),
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_DAYS * 86_400_000,
  });
}

const readCookie = (req) => (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

const registerBody = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(10).max(200),
  // Officers self-register but stay unverified until an admin approves. 'official' accounts are admin-created only.
  accountType: z.enum(['citizen', 'officer']).default('citizen'),
  officer: z.object({ agency: z.string().min(2).max(120), unit: z.string().min(2).max(120), rank: z.string().max(60).default(''), badgeId: z.string().min(2).max(60) }).optional(),
});

authRouter.post(
  '/register',
  validate(registerBody),
  ah(async (req, res) => {
    const { email, name, password, accountType, officer } = req.body;
    if (accountType === 'officer' && !officer) throw httpError(400, 'VALIDATION', 'Officer accounts need agency, unit and badge ID');
    if (await User.exists({ email: email.toLowerCase() })) throw httpError(409, 'EMAIL_TAKEN', 'Email already registered');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await User.create({ email, name, passwordHash, accountType, ...(accountType === 'officer' ? { officer } : {}) });
    await audit(`user:${user._id}`, { actorId: user._id, actorRole: 'user', action: 'USER_REGISTERED', target: String(user._id) });
    await issueRefresh(res, user._id);
    res.status(201).json({ accessToken: signAccess(user), user: publicUser(user) });
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  validate(z.object({ email: z.string().email(), password: z.string().min(1) })),
  ah(async (req, res) => {
    const user = await User.findOne({ email: req.body.email.toLowerCase() });
    // Same error for unknown user / wrong password / disabled.
    const ok = user && !user.disabled && (await argon2.verify(user.passwordHash, req.body.password));
    if (!ok) throw httpError(401, 'BAD_CREDENTIALS', 'Invalid email or password');
    await audit(`user:${user._id}`, { actorId: user._id, actorRole: 'user', action: 'LOGIN', target: String(user._id) });
    await issueRefresh(res, user._id);
    res.json({ accessToken: signAccess(user), user: publicUser(user) });
  }),
);

authRouter.post(
  '/refresh',
  ah(async (req, res) => {
    const token = readCookie(req);
    if (!token) throw httpError(401, 'UNAUTHENTICATED', 'No refresh token');
    const rec = await RefreshToken.findOne({ tokenHash: sha256Hex(token) });
    if (!rec) throw httpError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
    if (rec.revoked) {
      // Reuse of a rotated token: assume theft, kill the whole family.
      await RefreshToken.updateMany({ familyId: rec.familyId }, { revoked: true });
      throw httpError(401, 'TOKEN_REUSE', 'Refresh token reuse detected; signed out everywhere');
    }
    const user = await User.findById(rec.userId);
    if (!user || user.disabled) throw httpError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
    // Atomic rotate: only one concurrent request can flip revoked false -> true.
    const flipped = await RefreshToken.findOneAndUpdate({ _id: rec._id, revoked: false }, { revoked: true });
    if (!flipped) throw httpError(401, 'TOKEN_REUSE', 'Refresh token already used');
    await issueRefresh(res, user._id, rec.familyId);
    res.json({ accessToken: signAccess(user), user: publicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    const token = readCookie(req);
    if (token) {
      const rec = await RefreshToken.findOne({ tokenHash: sha256Hex(token) });
      if (rec) await RefreshToken.updateMany({ familyId: rec.familyId }, { revoked: true });
    }
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
    res.status(204).end();
  }),
);

export const meRouter = Router();
meRouter.use(requireAuth);
meRouter.get('/', (req, res) => res.json({ user: publicUser(req.user) }));
meRouter.patch(
  '/',
  validate(z.object({ name: z.string().min(1).max(100).optional(), uiLanguage: z.string().max(10).optional(), voiceLanguage: z.string().max(10).optional() })),
  ah(async (req, res) => {
    const u = await User.findByIdAndUpdate(req.user._id, req.body, { new: true });
    res.json({ user: publicUser(u) });
  }),
);
