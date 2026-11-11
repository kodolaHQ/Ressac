---
name: WebAiOs Aura
colors:
  light: { bg: "#F1F3F6", text: "#15171C", muted: "#5D6470", line: "rgba(21,23,28,.10)", glass: "rgba(255,255,255,.52)", glass-hi: "rgba(255,255,255,.78)", glass-edge: "rgba(255,255,255,.75)", sheet: "#FFFFFF", accent-ink: "#FFFFFF" }
  dark: { bg: "#0E1014", text: "#ECEEF2", muted: "#9AA1AD", line: "rgba(255,255,255,.09)", glass: "rgba(14,16,24,.66)", glass-hi: "rgba(255,255,255,.10)", glass-edge: "rgba(255,255,255,.10)", sheet: "#17191F", accent-ink: "#0E1014" }
auras:
  aube: { hues: ["#FF9F7A", "#FF6F91", "#FFD36E"], accent-light: "#C23A5E", accent-dark: "#FF8FA8" }
  lagon: { hues: ["#4FD1C5", "#3B8BEB", "#B7F0D8"], accent-light: "#1D64C8", accent-dark: "#6FB3FF" }
  verger: { hues: ["#A3D977", "#2F9E6E", "#F2E27D"], accent-light: "#2B7A4B", accent-dark: "#8FD18A" }
  glacier: { hues: ["#9CC3FF", "#7FE0F0", "#E8D9FF"], accent-light: "#3563C9", accent-dark: "#9CC3FF" }
  braise: { hues: ["#FF7A45", "#E8384F", "#FFB86B"], accent-light: "#C02A3C", accent-dark: "#FF8A6B" }
typography:
  display: { family: "Funnel Display", weight: "300-800" }
  ui: { family: "Geist", weight: "300-700", size: 13px, line-height: 1.4 }
  mono: { family: "Geist Mono", weight: "400-500" }
motion:
  tap: { duration: 120ms, scale: 0.97, easing: "cubic-bezier(.2,.8,.2,1)" }
  spring: { duration: 460ms, easing: "linear(0, .06 2.4%, .24 5.1%, .55 9.4%, .84 14.6%, 1.01 19.4%, 1.07 23.2%, 1.08 26.6%, 1.05 32.8%, 1 41%, .99 50%, 1)" }
  aura: { duration: 900ms, easing: ease-in-out }
  halo: { duration: 1.8s, easing: linear, loop: true }
veil: { light: "color-mix(bg 30%, transparent)", dark: "color-mix(color-mix(bg 88%, a2) 72%, transparent)" }
aura-layers: { light: { opacity: 0.95, blur: 70px, saturate: 1.15 }, dark: { opacity: 0.55, blur: 80px, saturate: 1.45 } }
radius: { control: 10px, card: 16px, window: 18px, page: 12px }
---

# WebAiOs : la charte Aura

Toute retouche visuelle suit ce fichier. Les valeurs vivent dans `apps/firefox/ui/theme.css` (variables CSS).

## La charte

- **Aura** : trois teintes floues qui dérivent lentement (`--a1`, `--a2`, `--a3`). Cinq auras : Aube (défaut), Lagon, Verger, Glacier, Braise.
- **Verre** : le chrome (barre latérale, panneau de l'agent, barre de commande, modales) est un voile translucide posé sur l'aura. L'aura ne touche jamais le contenu des sites : les pages gardent leur propre fond.
- **Neutres** : gris froids légèrement teintés, clair et sombre. Le thème suit macOS ; sombre par défaut.
- **Accent** : dérivé de l'aura de l'espace actif, plus de violet fixe. Chaque aura a un accent pour le clair et un pour le sombre (contraste AA). Le texte posé sur l'accent est `#0E1014` en sombre, blanc en clair. Les couleurs d'état (en cours, erreur, arrêté, accès lecture / action) restent sémantiques et indépendantes de l'aura.
- **Typo** : Funnel Display pour les titres, Geist pour l'interface, Geist Mono pour les raccourcis et le code court. Embarquées en woff2 (licence OFL), jamais chargées du réseau.
- **Mouvement**, quatre gestes seulement : toucher, ressort (ce qui apparaît), aura (changement d'espace), halo (l'agent agit sur la page).
- **Jamais d'apparition brute** : tout ce qui apparaît ou disparaît (panneau, menu, bulle, bandeau, carte) entre sur le
  ressort et sort par un fondu ou un glissement court. Un panneau latéral glisse sans dépassement (380 ms, la courbe du
  toucher) pour que la page le suive sans rebond. C'est une règle de chaque nouvelle interaction, pas une finition.
- **Réduire les animations** : auras figées, ressorts remplacés par des fondus de 150 ms au plus, halo fixe.

## Interdits

- Dégradé violet-bleu.
- Texte en dégradé.
- Animation au défilement.
- Plus d'une aura visible à la fois.
- Emoji décoratifs dans les titres.
- Mascotte ou robot pour l'agent : l'agent, c'est le halo.
- L'aura sur le contenu des sites, jamais.
