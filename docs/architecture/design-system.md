# DispatchOS — Design System v1.0

**Версия:** 1.0 · **Дата:** 16 мая 2026
**Цель:** единая палитра, типографика, spacing для admin / driver / dispatcher / lending. Чёрный premium b2b logistics, не флешевый.

---

## 1. Color tokens

### Base (от лендинга, проверены WCAG AA)

| Token | Hex | Использование |
|---|---|---|
| `--bg` | `#0a0e1a` | Главный фон всех экранов |
| `--bg-2` | `#0f1424` | Второй слой фона (sidebar, header) |
| `--surface` | `#161c2e` | Карточки, modal, inputs |
| `--surface-2` | `#1d2440` | Hover state карточек, secondary panels |
| `--surface-3` | `#252d4f` | Active state, nested elements |
| `--border` | `rgba(255,255,255,0.08)` | Все divider, card outline |
| `--border-strong` | `rgba(255,255,255,0.14)` | Hover border, focus ring base |

### Text

| Token | Hex | Контраст | Использование |
|---|---|---|---|
| `--text` | `#e8ecf5` | AAA on bg | Primary body, headings |
| `--text-muted` | `#9aa3ba` | AA on bg | Secondary text, labels |
| `--text-dim` | `#6b7390` | AA Large | Captions, placeholders |
| `--text-faint` | `#4a5070` | — | Disabled, dividers labels |

### Accent (brand orange — для всех CTA и status:active)

| Token | Hex | Использование |
|---|---|---|
| `--accent` | `#f59e0b` | Primary CTA, links, active state, focus ring |
| `--accent-hover` | `#fbbf24` | Hover state CTA |
| `--accent-soft` | `rgba(245,158,11,0.15)` | Background tag, badge, active row |
| `--accent-glow` | `rgba(245,158,11,0.35)` | Box-shadow на focus, blur glow |
| `--accent-text` | `#0a0e1a` | Text on accent background (CTA label) |

### Semantic (status colors)

| Token | Hex | Использование |
|---|---|---|
| `--good` | `#34d399` | Success, status: ok / on-route / approved / paid |
| `--good-soft` | `rgba(52,211,153,0.15)` | Success badge bg |
| `--bad` | `#f87171` | Error, status: failed / rejected / fraud-flag |
| `--bad-soft` | `rgba(248,113,113,0.15)` | Error badge bg |
| `--warn` | `#fbbf24` | Warning, status: at-risk / expiring soon / counter-pending |
| `--warn-soft` | `rgba(251,191,36,0.15)` | Warning badge bg |
| `--info` | `#60a5fa` | Info badge, neutral hint |
| `--info-soft` | `rgba(96,165,250,0.15)` | Info badge bg |

### Status palette (driver/load)

```
🟢 Available    → --good
🟡 In transit   → --warn
🔴 Off-duty     → --text-dim
🔵 Pending      → --info
⚪ Idle         → --text-faint
```

---

## 2. Typography

### Fonts (loaded via Google Fonts CDN)

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

| Token | Stack | Использование |
|---|---|---|
| `--font` | `'Inter', -apple-system, system-ui, sans-serif` | Весь UI |
| `--mono` | `'JetBrains Mono', ui-monospace, monospace` | MC#, $, IDs, code, ETA, PPM |

### Scale (compact for dense ops UI)

| Token | Size / Line | Использование |
|---|---|---|
| `--text-xs` | 12px / 16px | Captions, badges, table cell meta |
| `--text-sm` | 13px / 20px | Body small, secondary info |
| `--text-base` | 14px / 22px | Body default (admin, dispatcher) |
| `--text-md` | 16px / 24px | Body driver portal (mobile) |
| `--text-lg` | 18px / 26px | Section header, large input |
| `--text-xl` | 22px / 30px | Card title, dialog header |
| `--text-2xl` | 28px / 36px | Page title, dashboard H1 |
| `--text-3xl` | 36px / 44px | Hero, marketing only |
| `--text-4xl` | 48px / 56px | Landing hero |

### Weights

- 400 (regular) — body, descriptions
- 500 (medium) — labels, buttons
- 600 (semibold) — card titles, section headers, important numbers
- 700 (bold) — page titles, primary CTA label
- 800 (extrabold) — hero only (landing)

### Display rules

- **Numbers ($, PPM, MC, miles)** — всегда `font-mono`, `font-feature-settings: 'tnum'` (tabular numbers, aligned columns)
- **Tables** — `font-size: 13px` (--text-sm) для density
- **Mobile driver** — minimum `font-size: 16px` (--text-md) для читаемости в кабине

---

## 3. Spacing scale

4-based scale (Tailwind-совместимая):

| Token | px | Использование |
|---|---|---|
| `--space-0` | 0 | reset |
| `--space-1` | 4px | inline gap, badge padding |
| `--space-2` | 8px | tight stack, icon+text gap |
| `--space-3` | 12px | input padding-y, card inner |
| `--space-4` | 16px | default gap, button padding |
| `--space-5` | 20px | section internal |
| `--space-6` | 24px | card padding, container |
| `--space-8` | 32px | between sections |
| `--space-10` | 40px | between blocks |
| `--space-12` | 48px | major section gap |
| `--space-16` | 64px | hero gap |

---

## 4. Radius

| Token | px | Использование |
|---|---|---|
| `--radius-sm` | 6px | Inputs, badges |
| `--radius-md` | 10px | Buttons, small cards |
| `--radius-lg` | 14px | Cards, modal |
| `--radius-xl` | 20px | Hero cards, big panels |
| `--radius-full` | 9999px | Pills, avatars, status dots |

---

## 5. Shadow / glow

```css
--shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
--shadow-md: 0 4px 12px rgba(0,0,0,0.5);
--shadow-lg: 0 12px 32px rgba(0,0,0,0.6);
--shadow-glow: 0 0 24px var(--accent-glow);
--shadow-focus: 0 0 0 3px var(--accent-soft), 0 0 0 1px var(--accent);
```

Rule: **тени применять только к interactive elements** (buttons, cards с hover). Не на статичные блоки — это перегружает темную тему.

---

## 6. Component patterns

### Button

```
Primary:    bg accent, text accent-text, hover bg accent-hover
Secondary:  bg surface, text text, border border, hover bg surface-2
Ghost:      transparent, text text-muted, hover bg surface
Danger:     bg bad, text bg, hover bg bad (90% opacity)
Icon-only:  square (40x40 desktop / 44x44 mobile), radius-md
```

Sizes: `sm` 32px height, `md` 40px (default), `lg` 48px (hero CTA, mobile driver)

### Card

```
bg surface
border border
radius radius-lg
padding space-6
hover (если interactive): border border-strong, shadow shadow-md, transform translateY(-1px), transition 150ms
```

### Status badge

```
display inline-flex
padding 2px 8px
radius radius-full
font-size text-xs (12px)
font-weight 500
gap 6px (icon + text)
bg = <semantic>-soft
text = <semantic>

Examples:
🟢 ON ROUTE   → bg good-soft, text good
🟡 PENDING    → bg warn-soft, text warn
🔴 FAILED     → bg bad-soft, text bad
```

### Input

```
height 40px (sm 32, lg 48 для search/hero)
bg surface
border border
radius radius-md
padding 0 12px
font text-base
focus: border accent, shadow shadow-focus, transition 100ms
placeholder: text-dim
```

### Table

```
header row: bg bg-2, font-weight 600, text-muted, text-xs uppercase, letter-spacing 0.05em
body row: border-bottom border (only between rows)
row hover: bg surface
selected: bg accent-soft
cell padding: 12px 16px
numbers: font-mono, tnum, text-align right
```

---

## 7. Layout grids

### Admin & Dispatcher (desktop)

```
Layout: sidebar 240px + main flex-1
Sidebar: bg bg-2, border-right border
Top bar: 56px height, bg bg, border-bottom border, sticky
Main padding: space-6
Content max-width: 1440px
```

### Driver (mobile-first)

```
Layout: bottom-nav 64px + main 100vh - 64px
Top header: 56px sticky, bg bg, blur backdrop
Bottom nav: 4 tabs, bg bg-2, border-top border
Main padding: space-4 (16px)
Content max-width: 720px (для tablets)
```

### Landing

```
Container max-width: 760px (current), centered
Padding: 32px 24px (mobile) → 48px 32px (desktop)
```

---

## 8. Motion

```
--transition-fast: 100ms ease-out
--transition-base: 150ms ease-out
--transition-slow: 250ms ease-out
```

Rules:
- **Hover/focus** — `--transition-fast`
- **Cards, popovers** — `--transition-base`
- **Modals, sidebars** — `--transition-slow`
- **NEVER** animate `box-shadow` on every frame — use opacity transitions instead
- Respect `prefers-reduced-motion: reduce` — set all transitions to 0ms

---

## 9. Mobile breakpoints

```
sm: 640px  — large phone landscape
md: 768px  — tablet
lg: 1024px — desktop minimum
xl: 1280px — wide desktop
2xl: 1536px — wide screens
```

Driver portal — **mobile-first**, max-width 720px (tablet кабины).
Admin/Dispatcher — **desktop-first** lg+, mobile = read-only emergency view.

---

## 10. Icons

**Library:** `lucide-react` (уже в Phase 2 admin)
- Stroke width: 1.5 для UI, 2 для маленьких (badges, status)
- Size: 16px inline, 20px button, 24px nav, 32px+ hero

---

## 11. Tailwind config (drop-in)

```ts
// tailwind.config.ts extension
theme: {
  extend: {
    colors: {
      bg: { DEFAULT: '#0a0e1a', 2: '#0f1424' },
      surface: { DEFAULT: '#161c2e', 2: '#1d2440', 3: '#252d4f' },
      text: { DEFAULT: '#e8ecf5', muted: '#9aa3ba', dim: '#6b7390', faint: '#4a5070' },
      accent: {
        DEFAULT: '#f59e0b', hover: '#fbbf24',
        soft: 'rgba(245,158,11,0.15)', glow: 'rgba(245,158,11,0.35)',
      },
      good: { DEFAULT: '#34d399', soft: 'rgba(52,211,153,0.15)' },
      bad: { DEFAULT: '#f87171', soft: 'rgba(248,113,113,0.15)' },
      warn: { DEFAULT: '#fbbf24', soft: 'rgba(251,191,36,0.15)' },
      info: { DEFAULT: '#60a5fa', soft: 'rgba(96,165,250,0.15)' },
    },
    fontFamily: {
      sans: ['Inter', 'system-ui', 'sans-serif'],
      mono: ['JetBrains Mono', 'monospace'],
    },
    borderRadius: { sm: '6px', md: '10px', lg: '14px', xl: '20px' },
    boxShadow: {
      sm: '0 1px 2px rgba(0,0,0,0.4)',
      md: '0 4px 12px rgba(0,0,0,0.5)',
      lg: '0 12px 32px rgba(0,0,0,0.6)',
      glow: '0 0 24px rgba(245,158,11,0.35)',
      focus: '0 0 0 3px rgba(245,158,11,0.15), 0 0 0 1px #f59e0b',
    },
  },
}
```

---

## 12. Do / Don't

✅ **DO:**
- Использовать `--accent` ТОЛЬКО на интерактивных элементах (CTA, links, focus, active)
- Все числа — mono с tnum
- Все статусы — semantic colors + иконка/badge (не цвет один)
- Spacing — кратно 4
- Темно-холодные base + тёплый accent — это весь контраст

❌ **DON'T:**
- Не использовать accent на больших полях (не `bg-accent` для целой карточки)
- Не миксовать другие accent цвета (только orange — наш бренд)
- Не использовать чисто white `#ffffff` для текста — слишком резко на dark. Только `--text` (`#e8ecf5`)
- Не использовать pure black `#000` — глаза устают. `--bg` (`#0a0e1a`) даёт depth
- Не делать inputs / buttons меньше 32px высоты на desktop, 40px на mobile

---

*Все компоненты Phase 2 admin перекрашиваем по этой палитре. Phase 3 (driver / dispatcher) — пишем сразу в этой системе.*
