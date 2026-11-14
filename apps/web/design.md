# TraceVault — Design System

Source of truth for every frontend page. Derived from `hero-inspo.jpg`: a quiet, warm-paper
interface where a **dot-matrix display face** does the shouting, a **neo-grotesk** carries the
reading, and a **monospace** labels the machinery. Almost everything is ink on paper; a single
signal orange is spent sparingly.

Tokens live in `src/styles.css` (`:root`). Never hard-code a colour, font or radius in a component.

---

## 1. Mood

- Calm, precise, forensic. Trauma-informed (PRD §14.2): no loud colour fields, no gamified copy.
- Lots of air. Content sits in the middle of wide paper with hairline structure around it.
- "Engineered" details: hairline connector lines, small mono chips, dot grids, dot-matrix numerals.
- The product's evidence is serious; the UI is the steady, neutral instrument around it.

## 2. Colour palette

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#EEEDEA` | Page background (warm off-white) |
| `--paper-2` | `#E6E5E1` | Recessed wells, outer tile ring, hover on paper |
| `--surface` | `#F8F8F6` | Cards, bands, panels sitting on paper |
| `--white` | `#FFFFFF` | Nav bar, inputs, light buttons |
| `--ink` | `#0D0D0D` | Primary text, dark buttons, logo |
| `--ink-2` | `#3A3A38` | Body copy on light surfaces |
| `--muted` | `#8E8D89` | Secondary headline words, captions, helper text |
| `--line` | `#D6D5D1` | Hairlines, card borders, connectors |
| `--line-strong` | `#B9B8B3` | Chip outlines, input borders on focus-less state |
| `--signal` | `#E2603D` | **Accent** — CTA icon tile, focus ring, active/live states |
| `--signal-soft` | `#F6DDD4` | Signal backgrounds (badges) |
| `--ok` | `#2F7A55` | Sealed / verified |
| `--bad` | `#B5412A` | Errors, failed verification |
| `--warn` | `#A86A12` | Duplicates, needs review |

Rules
- Ink + paper do 95% of the work. Orange appears **at most once or twice per screen**.
- Headlines use the **two-tone** trick: key phrase in `--ink`, the rest in `--muted`
  (e.g. "Introducing the case file / *every sentence* / cited").
- Status colours are text/badge colours only — never fill large areas.
- The app is light-only by design (the paper look is the brand); contrast meets WCAG AA.

## 3. Typography

| Role | Family | Token | Notes |
|---|---|---|---|
| **Display** | **Doto** (dot-matrix) | `--font-display` | Hero words, big stats, numerals. Uppercase, weight 900, tracking `0.04em`. Never for body. |
| **Primary** | **Geist** | `--font-sans` | All headings and body. Headings weight 400–500, tight tracking (`-0.03em`). |
| **Secondary** | **Geist Mono** | `--font-mono` | Chips, eyebrows, hashes, metadata, table numbers. 11–13px. |

Loaded from Google Fonts in `index.html`.

Scale (fluid with `clamp`)

| Token | Size | Use |
|---|---|---|
| `--fs-mega` | clamp(44px, 8vw, 92px) | Dot-matrix hero words |
| `--fs-stat` | clamp(40px, 5vw, 56px) | Dot-matrix stats |
| `--fs-h1` | clamp(32px, 4.4vw, 48px) | Section titles, page titles |
| `--fs-h2` | clamp(24px, 3vw, 32px) | Sub-sections |
| `--fs-body` | 15px | Body |
| `--fs-small` | 13px | Captions, helper |
| `--fs-mono` | 11px | Chips, eyebrows (uppercase mono) |

## 4. Shape, space, elevation

- Radius: `--r-sm 8px` (inputs, chips' inner), `--r-md 12px` (buttons, icon tiles),
  `--r-lg 20px` (cards, bands), `--r-xl 32px` (hero tile ring), `999px` (chips).
- Spacing on a 4px grid; sections separated by 96–140px on desktop, 64px on mobile.
- Elevation is mostly **none**. Separation comes from surface colour + hairlines.
  The one shadow (`--shadow-soft`) is for the floating nav and light pill buttons.
- Max content width `1120px`; side gutter `16px` mobile, `24px` desktop.

## 5. Components
KEEP THE CARDS SIZES SIMILAR AND ALIGNED
**Nav bar** — floating white bar, inset 12px from the edges, radius 12, height 56. Logo left,
centred links (Geist 14px), right: "Log in" text link + dark "Get started" button.

**Dark button (`.btn-dark`)** — ink fill, white text, radius 12. Hero variant wraps an
orange icon tile (36px, radius 8) holding a dotted arrow, with a 3px ink ring + inner hairline.

**Light pill button (`.btn-light`)** — white, hairline border, soft shadow, radius 14;
leading 36px ink icon tile with a 3×3 white dot grid; label Geist 15px ink.

**Chip (`.chip`)** — mono 11px, 1px `--line-strong` outline, radius 999, white fill.
Used on the hero diagram and for evidence kinds / statuses.

**Card / band** — `--surface` fill, radius 20, no border on paper; columns separated
by vertical hairlines (as in the stats band).

**Stat** — dot-matrix numeral (`--fs-stat`) + Geist 15px caption below; mono eyebrow above.

**Eyebrow** — mono 11px uppercase, `--muted`, letter-spacing 0.08em.

**Inputs** — white, 1px `--line`, radius 10, 44px tall; focus ring 2px `--signal` at 35%.

**Badges** — mono 11px, radius 6, tinted background (`ok` / `warn` / `bad` / `signal`).

**Connector diagram** — 1px `--line-strong` lines, 6px ink dots at junctions, rounded
elbows. Small dots may travel along the lines (disabled under `prefers-reduced-motion`).

**ASCII flower (`FlowerField`)** — a canvas flower drawn as a dot grid (dot size and tone
follow density; dense centre in `--ink`, petals/leaves in `--muted`, sparse specks around).
Under the pointer (~120px radius) dots cross-fade into density-mapped glyphs
(`· : + = * ‡ # ▪`) with a light scramble at the edge, then ease back to dots. Taps work on
touch. Decorative only: `aria-hidden`; no scramble under reduced motion.

## 5a. Logo

Ink squircle holding a 5×5 dot grid. A "V" of white dots (vault, verify) converges on a single
`--signal` dot — the point every trace resolves to. Faint grid dots (22%) fill the rest.
Component: `LogoMark` in `src/ui.tsx`; static copy at `public/favicon.svg`. Wordmark is
"TraceVault" in Geist 600, `-0.02em`, set beside the mark at 10px gap. Don't recolour the
orange dot, rotate the mark, or place it on a busy background; keep clear space of one dot pitch.

## 6. Layout patterns

- **Marketing (/)**: nav → dot-matrix headline line 1 → connector diagram with central logo tile
  → headline line 2 → subtitle → CTA → stats band → two-column intro with dot field → closing
  statement row → footer.
- **App pages**: same floating nav; page header = eyebrow + H1 (two-tone allowed) + actions on
  the right; content in `--surface` cards on paper. Lists are cards with hairline rows.
- **Auth**: centred 420px card on paper, dot-matrix word above the form.

## 7. Voice

Short, plain, steady. Verbs over adjectives. "Seal", "cite", "verify". No exclamation marks,
no hype about victims' situations.

## 8. Motion

- 150–200ms ease-out for hover/focus. Buttons lift 1px on hover.
- Hero connector pulses: slow (4–6s), low-contrast. Everything off under reduced motion.
