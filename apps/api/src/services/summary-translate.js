// S8 / R5: translate the validated English summary sentence by sentence (citations unchanged), cached per version+lang.
import { Summary, ProviderUsage } from '../models/index.js';
import { mlJson } from './ml-client.js';
import { httpError } from '../middleware/index.js';

export async function translatedSummary(caseDoc, base, lang) {
  const cached = await Summary.findOne({ caseId: caseDoc._id, lang, version: base.version }).lean();
  if (cached) return cached;
  if (caseDoc.settings?.translateMode === 'off') throw httpError(409, 'TRANSLATION_OFF', 'Translation is turned off for this case');
  const items = base.sections.flatMap((s, si) => s.sentences.map((x, xi) => ({ id: `${si}.${xi}`, text: x.text, src: 'en-IN' })));
  const r = await mlJson('/translate', { items, target: lang, redact: caseDoc.settings?.translateMode === 'sarvam_redacted' });
  await ProviderUsage.insertMany((r.usage ?? []).map((u) => ({ ...u, caseId: caseDoc._id })));
  const by = new Map(r.items.map((i) => [i.id, i.text]));
  return (
    await Summary.create({
      caseId: caseDoc._id,
      version: base.version,
      lang,
      generator: { ...base.generator, translation: { provider: 'sarvam' } },
      stats: base.stats,
      sections: base.sections.map((s, si) => ({
        ...s,
        sentences: s.sentences.map((x, xi) => ({ ...x, textEn: x.text, text: by.get(`${si}.${xi}`) ?? x.text, machineTranslated: by.has(`${si}.${xi}`) })),
      })),
    })
  ).toObject();
}
