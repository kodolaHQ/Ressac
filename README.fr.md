<p align="center">
  <img src="apps/firefox/configs/branding/ressac/logo256.png" width="96" alt="">
</p>

<h1 align="center">Ressac</h1>

<p align="center">
  Un navigateur macOS basé sur Firefox, avec un agent IA à ses côtés.<br>
  <a href="README.md">Read in English</a>
</p>

<!-- IMAGE 1 : vue d'ensemble — barre latérale avec espaces, essentiels, onglets épinglés ; panneau agent fermé. docs/images/overview.png -->

> **Bêta.** Ressac sert tous les jours à un petit groupe de testeurs. Il reste des aspérités : dites-le-nous.

Le *ressac*, c'est la vague qui revient vers le rivage. Vous envoyez l'agent sur le web, il vous revient avec la réponse.

## Ce qu'il fait

**Un navigateur plus calme**
- Une barre latérale verticale avec des **espaces**, chacun sa couleur, des **essentiels** toujours chargés, des onglets épinglés et des dossiers.
- Une barre de commande sur <kbd>⌘T</kbd> / <kbd>⌘L</kbd> pour les adresses, favoris, historique, onglets et actions ; <kbd>⌃Tab</kbd> pour passer d'un onglet récent à l'autre.
- Des raccourcis modifiables et un mode Vim en option.
- Des **applis de site** : un site dans sa propre fenêtre, avec ses propres comptes, qui se souvient où vous en étiez.
- Une barre pour les appels (Meet, Teams, Zoom…) et pour le son ou la vidéo en arrière-plan.
- L'import depuis Arc, Chrome, Brave, Edge, Vivaldi, Opera, Safari, Firefox et Zen, espaces et onglets ouverts compris.
- Les extensions Firefox fonctionnent.

**Un agent qui navigue avec vous**
- Claude Code ou Codex tourne dans un conteneur isolé sur votre Mac, avec **votre propre compte**.
- Il navigue dans son propre onglet, que vous pouvez regarder ; une vignette montre ce qu'il fait pendant que vous continuez.
- Avant un achat ou un choix, il remplit un **récap en direct** : critères, sources indépendantes, offres, avantages et inconvénients sourcés.
- Il demande avant d'ouvrir une adresse qu'il a écrite lui-même, et vous rend la main quand une page a besoin de vous (connexion, captcha).
- Il peut vous créer des applis de site, des actions et des extensions, et changer l'apparence d'une page à la demande (mode design).

<!-- IMAGE 2 : récap en direct — vidéo (MP4, 15 à 25 s) : l'agent cherche, sa vignette flotte sur la page, le récap se remplit carte par carte. docs/images/live-recap.mp4 -->

**L'IA locale**
- Des **workflows** et des **veilles** qui tournent sur votre Mac avec Ollama : un petit modèle décide, un autre écrit.
- Une page d'accueil avec des widgets.

<!-- IMAGES 3 à 9 : panneau agent, barre ⌘T, constructeur de workflows, une appli de site, accueil et widgets, barre d'appel, import. docs/images/*.png -->

## Installer

Téléchargez le dernier DMG dans les [Releases](../../releases), ouvrez-le et glissez Ressac dans Applications. Ressac est signé et notarisé par Apple.

- macOS 14 ou plus récent, puce Apple.
- **Pour l'agent** : Docker ([OrbStack](https://orbstack.dev) ou Docker Desktop) et un compte Claude ou ChatGPT (ou une clé d'API). Ressac démarre lui-même l'app de conteneurs si elle est installée.
- **Pour l'IA locale** (facultatif) : [Ollama](https://ollama.com). Ressac le démarre, ou le télécharge pour vous (190 Mo).

Vous venez de WebAiOs, l'ancien nom de Ressac ? Quittez-le d'abord : au premier lancement, Ressac reprend vos données, votre profil, vos mots de passe et vos extensions.

## Vie privée

Vos données de navigation restent sur votre Mac. L'agent ne voit que les pages qu'il ouvre dans son onglet et ce que vous lui donnez. Ressac envoie à son développeur les plantages et les erreurs (sans adresse de page) et un identifiant d'installation anonyme, pour corriger les bugs de la bêta ; désactivable dans Réglages › Vie privée.

## Compiler depuis les sources

Ressac se compile avec [surfer](https://github.com/zen-browser/surfer), qui télécharge Firefox et applique les patches de Ressac. Il faut macOS sur puce Apple, les outils en ligne de commande de Xcode, Python 3.10+, Rust, GNU tar, Node 22 et pnpm (via corepack), et environ 25 Go de disque.

```sh
corepack pnpm install
corepack pnpm --filter firefox-ressac engine:install   # télécharge Firefox, hors du dépôt
corepack pnpm --filter firefox-ressac engine:import    # applique les patches
corepack pnpm --filter firefox-ressac build            # build complet, environ 20 min
```

Le reste (architecture, builds de l'interface seule, tests, paquet) est dans [apps/firefox/README.md](apps/firefox/README.md), en anglais. Les règles visuelles sont dans [DESIGN.md](DESIGN.md).

## Crédits

Ressac repose sur le travail d'autres projets :

- [Firefox](https://www.mozilla.org/firefox/) de Mozilla (MPL 2.0), le moteur et l'essentiel du navigateur.
- [surfer](https://github.com/zen-browser/surfer) de l'équipe de Zen Browser (MPL 2.0), l'outil de build.
- [Node.js](https://nodejs.org) et [node-pty](https://github.com/microsoft/node-pty) (MIT), embarqués pour l'hôte de l'agent.
- [Ollama](https://ollama.com) (MIT), pour les modèles locaux, téléchargé à la demande.
- [Gemma 4](https://ai.google.dev/gemma) de Google et pplx-decider-flash de Perplexity (Apache 2.0), modèles locaux téléchargés à la demande.
- [Claude Code](https://claude.com/claude-code) d'Anthropic et [Codex](https://github.com/openai/codex) d'OpenAI, les agents, installés dans le conteneur et utilisés avec votre propre compte.
- [Svelte](https://svelte.dev), [Vite](https://vite.dev), et les polices [Geist](https://vercel.com/font) et [Funnel Display](https://fonts.google.com/specimen/Funnel+Display) (OFL).

La liste complète des licences tierces embarquées est dans l'application, dossier `Contents/Resources/ressac-host/LICENSES`.

## Licence

[Mozilla Public License 2.0](LICENSE). Le nom Ressac et son logo ne sont pas couverts par la licence.
