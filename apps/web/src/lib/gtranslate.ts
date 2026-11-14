// Page translation with the Google Translate widget (no API key, no cost).
//
// PRIVACY: the widget sends the page's visible text to Google. This product shows a victim's private evidence, so:
//   - nothing contacts Google until the user picks a language and agrees to a notice;
//   - evidence-derived text is excluded (translate="no") and re-applied as the page changes (see PROTECT);
//   - English is the default and needs no third party at all.
// Case content already has its own cited translation path (Sarvam), which keeps the original beside the translation.

export const LANGS: [code: string, label: string][] = [
  ['en', 'English'], ['hi', 'हिन्दी'], ['kn', 'ಕನ್ನಡ'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'],
  ['ml', 'മലയാളം'], ['mr', 'मराठी'], ['bn', 'বাংলা'], ['gu', 'ગુજરાતી'], ['pa', 'ਪੰਜਾਬੀ'], ['or', 'ଓଡ଼ିଆ'],
];

/** Evidence-derived or personal content that must never be machine-translated or sent to Google. */
export const PROTECT = [
  '.no-gt', '.bilingual', '.chat', '.bubble', '.chunks', '.chunk', '.transcript', '.seg-row', '.inc-sides', '.inc-side',
  '.sum-sec', '.tl-card', '.ev-item', '.cite-text', '.cite-en', '.preview', '.narr', '.case-title', '.idents',
  '.kv dd', '.meta-table td', '.hash', '.hashbox', '.mono', 'textarea', 'input', 'pre', 'code',
].join(',');

const CONSENT_KEY = 'tv_gt_consent';
const COOKIE = 'googtrans';

export function currentLang(): string {
  const m = new RegExp(`(?:^|; )${COOKIE}=/[^/]*/([^;]+)`).exec(document.cookie);
  return m && LANGS.some(([c]) => c === m[1]) ? m[1] : 'en';
}

const setCookie = (value: string | null) => {
  const host = location.hostname;
  const exp = value ? '' : '; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  // The widget reads the cookie on the bare host and some versions on the dotted domain: write both.
  for (const domain of ['', `; domain=${host}`, `; domain=.${host}`]) document.cookie = `${COOKIE}=${value ?? ''}; path=/${domain}${exp}`;
};

export const hasConsent = () => { try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; } };
export const giveConsent = () => { try { localStorage.setItem(CONSENT_KEY, '1'); } catch { /* storage blocked */ } };

/** Switch language. The widget reads its cookie on load, so a reload applies (or removes) the translation cleanly. */
export function switchLang(code: string) {
  setCookie(code === 'en' ? null : `/en/${code}`);
  location.reload();
}

/** Mark protected content translate="no". Cheap and idempotent; runs for every DOM change while translated. */
function protect(root: ParentNode) {
  root.querySelectorAll?.(PROTECT).forEach((el) => { if (el.getAttribute('translate') !== 'no') el.setAttribute('translate', 'no'); });
}

/**
 * Load the widget only when a non-English language is active and the user has agreed. Returns a cleanup.
 * Safe to call repeatedly (React StrictMode runs effects twice): the observer is always re-armed, the widget is injected once.
 * Protection is applied before the widget script is requested, and on every later DOM change, so protected text is
 * never visible to the translator.
 */
export function startTranslation(): () => void {
  if (currentLang() === 'en' || !hasConsent()) return () => {};
  protect(document);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => { if (n instanceof Element) { if (n.matches(PROTECT)) n.setAttribute('translate', 'no'); protect(n); } });
  });
  obs.observe(document.body, { childList: true, subtree: true });

  if (!document.getElementById('google_translate_element')) {
    const host = document.createElement('div');
    host.id = 'google_translate_element';
    host.className = 'notranslate';
    host.style.display = 'none';
    document.body.appendChild(host);
    (window as any).tvGoogleInit = () => {
      const g = (window as any).google;
      new g.translate.TranslateElement({ pageLanguage: 'en', autoDisplay: false, includedLanguages: LANGS.filter(([c]) => c !== 'en').map(([c]) => c).join(',') }, 'google_translate_element');
    };
    const s = document.createElement('script');
    s.src = 'https://translate.google.com/translate_a/element.js?cb=tvGoogleInit';
    s.async = true;
    document.head.appendChild(s);
  }
  return () => obs.disconnect();
}
