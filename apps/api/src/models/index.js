import mongoose from 'mongoose';
const { Schema } = mongoose;

const user = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    // citizen = complainant; officer = police / investigator (self-registered, unverified until an admin approves);
    // official = government oversight (aggregates only; created by an admin, never self-registered).
    accountType: { type: String, enum: ['citizen', 'officer', 'official'], default: 'citizen' },
    officer: {
      agency: String,
      unit: String,
      rank: String,
      badgeId: String,
      verifiedAt: Date,
      verifiedBy: Schema.Types.ObjectId,
      rejectedAt: Date,
      rejectReason: String,
    },
    disabled: { type: Boolean, default: false },
    uiLanguage: { type: String, default: 'en-IN' },
    voiceLanguage: { type: String, default: 'hi-IN' },
  },
  { timestamps: true },
);

const refreshToken = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    revoked: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true },
);

const caseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    incidentType: { type: String, enum: ['harassment', 'fraud', 'stalking', 'sextortion', 'other'], default: 'other' },
    description: { type: String, default: '', maxlength: 5000 },
    tags: [String],
    status: { type: String, enum: ['draft', 'processing', 'ready'], default: 'draft' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    members: [
      {
        _id: false,
        userId: { type: Schema.Types.ObjectId, required: true },
        role: { type: String, enum: ['owner', 'collaborator', 'legal', 'investigator'], required: true },
      },
    ],
    settings: {
      llmMode: { type: String, enum: ['cloud', 'cloud_redacted', 'local'], default: 'cloud_redacted' },
      voiceMode: { type: String, enum: ['sarvam', 'local'], default: 'sarvam' },
      voiceConsentAt: Date,
      voiceConsentBy: Schema.Types.ObjectId,
      translateMode: { type: String, enum: ['sarvam', 'sarvam_redacted', 'off'], default: 'sarvam_redacted' },
      uiLanguage: { type: String, default: 'en-IN' },
    },
    deletedAt: Date,
    evidenceSeq: { type: Number, default: 0 },
    processedAt: Date,
  },
  { timestamps: true },
);
caseSchema.index({ 'members.userId': 1 });

const evidence = new Schema(
  {
    caseId: { type: Schema.Types.ObjectId, required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
    kind: { type: String, enum: ['chat_export', 'image', 'audio', 'pdf', 'email', 'statement', 'archive', 'other'], required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    sourceLabel: { type: String, default: '' },
    parentEvidenceId: Schema.Types.ObjectId,
    duplicateOf: Schema.Types.ObjectId,
    storage: { backend: { type: String, default: 'gridfs' }, fileId: Schema.Types.ObjectId },
    enc: { iv: String, tag: String, key: { wrapped: String, iv: String, tag: String } },
    status: { type: String, enum: ['uploaded', 'processing', 'done', 'failed'], default: 'uploaded' },
    idx: Number, // per-case sequence used in citations: [E{idx}:{chunkIdx}]
    metadata: Schema.Types.Mixed,
    flags: [Schema.Types.Mixed],
    hashes: Schema.Types.Mixed, // perceptual hashes for images
    durationMs: Number,
    detectedLang: String,
    error: String,
    provider: String, // e.g. 'sarvam' | 'local_whisper' for transcripts
    redacted: { at: Date, by: Schema.Types.ObjectId, reason: String },
  },
  { timestamps: true },
);
evidence.index({ caseId: 1, sha256: 1 });
evidence.index({ caseId: 1, idx: 1 }, { unique: true, partialFilterExpression: { idx: { $exists: true } } });

const auditEntry = new Schema(
  {
    caseId: { type: String, required: true },
    seq: { type: Number, required: true },
    ts: { type: String, required: true },
    actorId: String,
    actorRole: String,
    action: { type: String, required: true },
    target: String,
    payloadHash: String,
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { versionKey: false },
);
auditEntry.index({ caseId: 1, seq: 1 }, { unique: true });

const oid = Schema.Types.ObjectId;
const mixed = Schema.Types.Mixed;

// Derived data. Everything below is regenerable from the sealed originals.
const derivedArtifact = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    evidenceId: { type: oid, required: true, index: true },
    type: { type: String, required: true }, // ocr | transcript | parsed_chat | pdf_text | email_parsed | archive | narrative | tts_audio
    sourceSha256: String,
    generator: mixed, // {name, version, model, provider}
    data: mixed,
  },
  { timestamps: true },
);

const chunk = new Schema(
  {
    caseId: { type: oid, required: true },
    evidenceId: { type: oid, required: true },
    cid: { type: String, required: true }, // "E3:12"
    idx: Number,
    unit: String,
    text: String,
    textEn: String,
    lang: String,
    langConfidence: Number,
    translation: mixed,
    sender: String,
    speaker: String,
    refTs: String,
    tsSource: String,
    sourceType: { type: String, enum: ['document', 'self_statement'], default: 'document' },
    locator: mixed,
    conf: Number,
    lowConfidence: Boolean,
    timeOfDay: String,
    media: String,
    failed: Boolean,
    entities: [mixed],
    times: [mixed],
    severity: mixed,
  },
  { versionKey: false },
);
chunk.index({ caseId: 1, cid: 1 }, { unique: true });
chunk.index({ evidenceId: 1, idx: 1 });
chunk.index({ caseId: 1, lang: 1 });

const entity = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    key: { type: String, required: true },
    type: String,
    name: String,
    aliases: [String],
    aliasKeys: [String],
    identifiers: mixed,
    ownerKeys: [String],
    mentionChunkIds: [String],
    mentionCount: Number,
    evidenceIds: [String],
    isOwner: Boolean,
  },
  { versionKey: false },
);
entity.index({ caseId: 1, key: 1 }, { unique: true });

const timelineEvent = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    key: { type: String, required: true },
    ts: String,
    tsEnd: String,
    tsPrecision: String,
    title: String,
    description: String,
    descriptionEn: String,
    category: String,
    severity: Number,
    labels: [String],
    actors: [String],
    targets: [String],
    location: String,
    amount: Number,
    identifiers: [String],
    citations: [String],
    evidenceIds: [String],
    sourceType: String,
    lane: String,
    confidence: Number,
    corroborationCount: Number,
    audio: mixed,
    userEdited: Boolean,
  },
  { versionKey: false },
);
timelineEvent.index({ caseId: 1, key: 1 }, { unique: true });
timelineEvent.index({ caseId: 1, ts: 1 });

const duplicateGroup = new Schema(
  { caseId: { type: oid, required: true, index: true }, key: String, kind: String, score: Number, canonical: String, members: [mixed], detail: mixed, verdict: String },
  { versionKey: false },
);

const inconsistency = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    key: { type: String, required: true },
    type: String,
    subtype: String,
    severity: Number,
    title: String,
    explanation: String,
    refs: [mixed],
    confidence: Number,
    identifier: String,
  },
  { versionKey: false },
);
inconsistency.index({ caseId: 1, key: 1 }, { unique: true });

// Human decisions — never regenerated, re-applied on every rebuild.
const decision = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    kind: { type: String, enum: ['must_link', 'cannot_link', 'event_override', 'inconsistency_status', 'duplicate_verdict'], required: true },
    key: String, // event key / inconsistency key / duplicate key
    a: String,
    b: String,
    data: mixed,
    by: oid,
  },
  { timestamps: true },
);
decision.index({ caseId: 1, kind: 1, key: 1 });

// Graph, insights, candidates, mentions: one snapshot per case, replaced on rebuild.
const caseSnapshot = new Schema(
  {
    caseId: { type: oid, required: true, unique: true },
    graph: mixed,
    insights: mixed,
    candidates: [mixed],
    keyMoments: [String],
    mentions: mixed,
    generator: mixed,
    builtAt: Date,
    durationMs: Number,
  },
  { versionKey: false, minimize: false },
);

const summary = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    version: Number,
    lang: { type: String, default: 'en-IN' },
    sections: [mixed],
    generator: mixed,
    stats: mixed,
    createdBy: oid,
  },
  { timestamps: true },
);
summary.index({ caseId: 1, lang: 1, version: -1 });

// A complainant's time-limited, revocable share of a case with a lawyer or police officer.
// The invite token is shown once; only its SHA-256 is stored. Accepting binds the grant to a user and adds
// them to case.members; every protected request re-checks that the grant is active.
const shareGrant = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    ownerId: { type: oid, required: true },
    recipientEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    role: { type: String, enum: ['legal', 'investigator', 'collaborator'], required: true },
    scope: { type: { type: String, enum: ['case', 'evidence'], default: 'case' }, evidenceIds: [String] },
    allowDownload: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    tokenHash: { type: String, required: true, unique: true },
    acceptedBy: oid,
    acceptedAt: Date,
    revokedAt: Date,
    viewCount: { type: Number, default: 0 },
    lastViewedAt: Date,
    // officer workflow, visible to the owner
    officerStatus: { type: String, enum: ['received', 'under_review', 'needs_evidence', 'fir_registered', 'closed'], default: 'received' },
    statusAt: Date,
    firNumber: String,
    requests: [{ _id: false, at: Date, by: oid, message: String }],
    notes: { type: String, default: '', maxlength: 5000 }, // private to the recipient
  },
  { timestamps: true },
);
shareGrant.index({ acceptedBy: 1, revokedAt: 1 });

const providerUsage = new Schema(
  {
    ts: { type: Date, default: Date.now, index: true },
    caseId: oid,
    provider: String,
    endpoint: String,
    model: String,
    audioSeconds: Number,
    chars: Number,
    latencyMs: Number,
    status: mixed,
  },
  { versionKey: false },
);

export const User = mongoose.model('User', user);
export const RefreshToken = mongoose.model('RefreshToken', refreshToken);
export const Case = mongoose.model('Case', caseSchema);
export const Evidence = mongoose.model('Evidence', evidence);
export const AuditEntry = mongoose.model('AuditEntry', auditEntry);
export const DerivedArtifact = mongoose.model('DerivedArtifact', derivedArtifact);
export const Chunk = mongoose.model('Chunk', chunk);
export const Entity = mongoose.model('Entity', entity);
export const TimelineEvent = mongoose.model('TimelineEvent', timelineEvent);
export const DuplicateGroup = mongoose.model('DuplicateGroup', duplicateGroup);
export const Inconsistency = mongoose.model('Inconsistency', inconsistency);
export const Decision = mongoose.model('Decision', decision);
export const CaseSnapshot = mongoose.model('CaseSnapshot', caseSnapshot);
// Drafted narrative of a recorded voice statement (spec §6.4). Edits create a new version; none is overwritten.
const statement = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    evidenceId: { type: oid, required: true },
    version: { type: Number, required: true },
    lang: String,
    textNative: String,
    textEn: String,
    sentences: [{ _id: false, text: String, citations: [String] }],
    suggestions: mixed,
    appliedSuggestions: [String],
    generator: mixed,
    editedBy: oid,
    note: String,
  },
  { timestamps: true },
);
statement.index({ evidenceId: 1, version: -1 }, { unique: true });

export const Summary = mongoose.model('Summary', summary);
export const Statement = mongoose.model('Statement', statement);
export const ProviderUsage = mongoose.model('ProviderUsage', providerUsage);
export const ShareGrant = mongoose.model('ShareGrant', shareGrant);

// Notes on an evidence item (spec E9). Stored apart from the sealed original; authors can delete only their own.
const annotation = new Schema(
  {
    caseId: { type: oid, required: true, index: true },
    evidenceId: { type: oid, required: true, index: true },
    authorId: { type: oid, required: true },
    authorName: String,
    authorRole: { type: String, enum: ['owner', 'collaborator', 'legal'], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    chunkId: String, // optional: the chunk ("E3:12") the note is about
  },
  { timestamps: true },
);
export const Annotation = mongoose.model('Annotation', annotation);
