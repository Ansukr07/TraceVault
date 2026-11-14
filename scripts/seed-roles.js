// Demo accounts for the officer / oversight / admin surfaces + one accepted share on the demo case.
//   npm run seed:roles        (needs MONGO_URI in .env; run `npm run seed:demo` first for the demo case)
// All three share the demo password below. Local demo data only.
import crypto from 'node:crypto';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { Case, ShareGrant, User } from '../apps/api/src/models/index.js';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'tracevault-demo-password';
const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
await mongoose.connect(process.env.MONGO_URI, process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : {});

async function upsert(email, fields) {
  return User.findOneAndUpdate({ email }, { $set: { name: fields.name, accountType: fields.accountType ?? 'citizen', isAdmin: !!fields.isAdmin, ...(fields.officer ? { officer: fields.officer } : {}) }, $setOnInsert: { email, passwordHash } }, { upsert: true, new: true });
}

const admin = await upsert('admin.demo@tracevault.test', { name: 'Platform Admin', isAdmin: true });
const official = await upsert('official.demo@tracevault.test', { name: 'Meera Nair (Home Dept.)', accountType: 'official' });
const officer = await upsert('officer.demo@tracevault.test', {
  name: 'Insp. Arjun Rao',
  accountType: 'officer',
  officer: { agency: 'Bengaluru City Police', unit: 'Cyber Crime Cell', rank: 'Inspector', badgeId: 'BCP-89241', verifiedAt: new Date(), verifiedBy: admin._id },
});
const lawyer = await upsert('lawyer.demo@tracevault.test', { name: 'Adv. Ritu Menon' });
// A second, still-unverified officer so the admin verification queue has something in it.
await upsert('pending.officer@tracevault.test', {
  name: 'SI Kavya Shetty',
  accountType: 'officer',
  officer: { agency: 'Mysuru City Police', unit: 'CEN Police Station', rank: 'Sub-Inspector', badgeId: 'MCP-30177' },
});

const owner = await User.findOne({ email: process.env.DEMO_EMAIL ?? 'priya.demo@tracevault.test' });
const c = owner && (await Case.findOne({ 'members.userId': owner._id, title: /^Priya v\. Rahul/, deletedAt: null }));
if (!c) {
  console.log('Accounts ready, but no demo case found; run `npm run seed:demo` (or log in as the demo user and create a case), then re-run this script to add the share.');
} else {
  for (const [user, role, days] of [[officer, 'investigator', 30], [lawyer, 'legal', 14]]) {
    const m = c.members.find((x) => String(x.userId) === String(user._id));
    if (m) m.role = role;
    else c.members.push({ userId: user._id, role });
    await c.save();
    const exists = await ShareGrant.exists({ caseId: c._id, acceptedBy: user._id, revokedAt: null });
    if (!exists) {
      await ShareGrant.create({
        caseId: c._id,
        ownerId: owner._id,
        recipientEmail: user.email,
        role,
        scope: { type: 'case', evidenceIds: [] },
        allowDownload: true,
        expiresAt: new Date(Date.now() + days * 86_400_000),
        tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
        acceptedBy: user._id,
        acceptedAt: new Date(),
        statusAt: new Date(),
      });
    }
    console.log(`Share on "${c.title}" → ${user.email} (${role}, ${days} days)`);
  }
}

console.log(`\nPassword for all: ${PASSWORD}`);
console.log('  lawyer    lawyer.demo@tracevault.test    → /legal');
console.log('  officer   officer.demo@tracevault.test   → /officer');
console.log('  official  official.demo@tracevault.test  → /oversight');
console.log('  admin     admin.demo@tracevault.test     → /admin');
await mongoose.disconnect();
