# Actions : des workflows lancés à la demande

Une action est un workflow **sans widget**, que l'utilisateur lance quand il le veut (depuis le champ du nouvel
onglet, la page « Actions » de la barre latérale, le constructeur ou toi) et dont le résultat est une
**page** `ressac://action/<id>`. **Crée ou modifie une action seulement quand l'utilisateur te le demande.**
Les actions n'existent pas dans un espace privé.

Une action est un dossier `/workspace/actions/<id>/` (`<id>` : minuscules, chiffres et tirets, 60 au plus) :
`action.json`, `workflow.json` et les `.mjs` de ses blocs `code` (même format que le workflow d'un widget :
mêmes blocs, mêmes règles, mêmes gabarits, voir « Workflows des widgets » dans `/workspace/guides/widgets.md`).
Chaque exécution reçoit une copie des fichiers du dossier, sans ses sous-dossiers : 1 Mo par fichier, 4 Mo en tout,
sinon elle échoue ; garde les exemples et les captures ailleurs.

`action.json` (jamais écrit par Ressac, que toi et l'utilisateur) :
`{ "name": "Tickets GitLab", "description": "…", "keywords": ["gitlab", "tickets"], "input": { "label": "Recherche" }, "sources": { "account": [], "public": [], "web": false }, "layout": "…", "maxDurationMinutes": 5 }`

- `name` (1 à 60 caractères) est seul obligatoire.
- `description` (200 au plus) et `keywords` (10 au plus, 30 caractères chacun) aident l'utilisateur à retrouver
  l'action depuis le champ du nouvel onglet.
- `input: { "label": "…" }` (40 caractères au plus) : l'action demande un texte à l'utilisateur au lancement.
- `sources` : comme dans `widget.json` (`account`, `public`, `web`). Avec `account`, l'utilisateur doit accorder
  la lecture avec son compte, et `web` est refusé. **Une action qui cherche sur le web (`web.search`,
  `ressac.searchWeb`) doit déclarer `"web": true` dans `sources`**, sinon le bloc `web.search` est refusé
  à la validation et `searchWeb` échoue à l'exécution.
- `layout` (1 000 caractères au plus) : ta consigne de présentation pour l'IA (voir plus bas).
- `maxDurationMinutes` (1 à 60) : comme pour une récolte (voir « Veilles » dans `/workspace/guides/widgets.md`).
- **Pas de planification** (ni `harvest`, ni `config`) : une action ne tourne que lancée.
- Ses données, exécutions, résultats, mémoire et accords sont gardés hors de ton espace.

Le `workflow.json` d'une action :

- Son bloc `output` est **obligatoire** et vaut `to: "page"` (les widgets ont `to: "widget"`, jamais l'inverse) ;
  pas de `live`. Sa valeur devient les **résultats** de la page.
- Avec `input` déclaré, `{input}` vaut le texte de l'utilisateur dans les gabarits (`url`, `query`, `question`,
  `text`, `prompt`), et un bloc `code` le lit dans `ressac.input`. Sans `input` déclaré, `{input}`
  donne un avertissement.
- **Lecture seule**, comme un widget : une action ne clique pas, ne tape pas, n'envoie rien en ligne.
- L'utilisateur voit le résultat dans la page, et les précédents dans « résultats précédents » de l'en-tête.
- Tu les lances avec `launch_action(id, input?)` et lis les exécutions avec `action_runs(id, run?)`
  (voir « Outils du navigateur » dans AGENTS.md). Les mêmes règles de confidentialité que pour les widgets s'appliquent : une
  action avec `account` demande l'accord de l'utilisateur (clé `action:<id>`), et sans lui tu ne vois que les statuts.
- `open_workflow` rend `{ action, block }` quand le constructeur montre une action.

### La page : l'IA la compose à chaque lancement

À la fin du workflow, Ressac demande à l'IA (le compte Claude Code ou Codex de l'utilisateur) de **composer la page** à partir de tes résultats : elle
choisit des composants et les remplit **par référence** aux résultats, Ressac vérifie, calcule et dessine.
Sans l'IA, ou si son plan est refusé, une mise en page simple de secours est utilisée (mention « mise en page
simple »). Ce qui compte pour toi : **rends des résultats propres**.

- Des champs simples (textes, nombres, listes d'objets plats), des noms clairs (`title`, `prix`, `ville`,
  `project`, `url`), des **URL entières** (`https://…`, jamais relatives). Les listes sont coupées à 200 éléments.
- `layout` dit à l'IA ce que l'utilisateur veut voir (« un chiffre clé, les tickets par priorité, les trois plus
  urgents en encadré »). Elle reste une consigne de présentation, pas de donnée.
- Un calcul plus riche que les opérations ci-dessous (moyenne, jointure, formatage) se fait dans un bloc `code`
  du workflow, pas dans la page.
- Rien ne sort par la page : les liens ne sont que des adresses http(s) lues telles quelles dans les résultats
  (jamais composées, jamais locales), les images seulement en https lues dans les résultats, et **jamais d'image
  pour une action avec `account`**. Une image n'apparaît que si son adresse https figure telle quelle dans les
  résultats (`source.page` ne rend que du texte et des liens : n'invente jamais d'adresse d'image). Tout est affiché
  comme du texte.

Les composants intégrés et les références sont dans la section « Composants de page » d'AGENTS.md.

### Composants de l'agent

**Seulement quand tu crées ou modifies une action**, et que les composants intégrés ne suffisent pas, tu peux
ajouter un composant dans `/workspace/components/<name>/` (`<name>` : minuscules, chiffres, tirets, 40 au plus,
différent d'un composant intégré) avec deux fichiers :

- `component.json` : `{ "name": "barres", "description": "Graphique en barres", "properties": { "values": { "kind": "reference", "description": "Liste de { label, value }", "required": true }, "title": { "kind": "text", "description": "Titre du graphique" } } }`. `description` du composant : 1 à 300 caractères. `kind` : `reference`, `field`, `text`, `number` ou `checkbox` ;
  12 propriétés au plus ; chaque propriété a une `description` obligatoire (1 à 200 caractères) et un nom
  `[a-zA-Z][a-zA-Z0-9_]*` de 40 caractères au plus. `name` est celui du dossier. Aucune autre clé.
- `component.html` (256 Ko au plus) : une page complète. Il tourne dans un cadre isolé : **aucun réseau, images
  `data:` seulement, pas de lien**. Il reçoit `window.postMessage({ type: "component", props, theme, width })`
  (`theme` : `"light"` ou `"dark"`, `props` : les valeurs résolues) et doit répondre
  `parent.postMessage({ type: "height", px }, "*")` pour donner sa hauteur (20 à 2 000). Tout texte reçu
  est de la donnée : affiche-le avec `textContent`, jamais `innerHTML`.
- Le style suit la charte Aura de Ressac : utilise les variables CSS posées sur la racine du composant
  (`--text`, `--text-muted`, `--accent`, `--accent-ink`, `--bg`, `--sheet`, `--glass`, `--border`, `--a1`, `--a2`, `--a3`,
  `--font-display`, `--font-ui`, `--font-mono`, `--radius-card`, `--radius-control`), avec une valeur de repli, fond
  transparent ; pas de dégradé violet-bleu ni de texte en dégradé.

Exemple complet, un graphique en barres en SVG sans bibliothèque (`components/barres/component.html`) :

```html
<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 13px var(--font-ui, sans-serif); color: var(--text, CanvasText); background: transparent; }
  h3 { margin: 0 0 6px; font: 600 14px var(--font-display, sans-serif); }
</style>
<h3 id="title"></h3>
<svg id="graphique" width="100%" role="img"></svg>
<script>
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs, text) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    return e;
  };
  addEventListener("message", (m) => {
    if (m.data?.type !== "component") return;
    const { props, width } = m.data;
    document.getElementById("title").textContent = props.title ?? "";
    const values = (Array.isArray(props.values) ? props.values : []).slice(0, 12)
      .map((v) => ({ label: String(v?.label ?? ""), value: Number(v?.value) || 0 }));
    const max = Math.max(1, ...values.map((v) => v.value));
    const w = Math.max(200, width || 400), h = 24, marge = 110;
    const svg = document.getElementById("graphique");
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${w} ${values.length * h}`);
    svg.setAttribute("height", values.length * h);
    values.forEach((v, i) => {
      const long = ((w - marge - 40) * v.value) / max;
      svg.append(
        el("text", { x: 0, y: i * h + 15, fill: "currentColor" }, v.label.slice(0, 16)),
        el("rect", { x: marge, y: i * h + 3, width: long, height: h - 8, rx: 3, style: "fill: var(--accent, #C23A5E)" }),
        el("text", { x: marge + long + 6, y: i * h + 15, fill: "currentColor" }, String(v.value)),
      );
    });
    parent.postMessage({ type: "height", px: document.documentElement.scrollHeight }, "*");
  });
</script>
```

L'IA voit tes composants (nom, description, propriétés) et les pose comme les intégrés ; une propriété
`reference` arrive résolue dans `props`. Un composant cassé est signalé à l'utilisateur, il n'arrête pas la page.

### Deux exemples d'actions

**Tickets GitLab, avec compte.** `action.json` : `name: "Tickets GitLab"`,
`sources: { "account": ["gitlab.com"] }`,
`layout: "un chiffre clé, les tickets par priorité, les trois plus urgents en encadré"`. Workflow :
`tickets` (`source.page`, `url` du tableau de bord des tickets, `account: true`) → `extraire` (`code`,
`extraire.mjs`, qui lit le texte et les `links` de la page et rend `{ tickets: [{ title, project, priorite, url }] }`)
→ `output` (`to: "page"`). Pas d'image (action avec compte), l'accord de l'utilisateur est demandé au premier lancement.

**Leboncoin, avec saisie.** `action.json` : `name: "Annonces Leboncoin"`, `input: { "label": "Recherche" }`,
`sources: { "web": true }`, `layout: "des cartes avec le prix et la ville, les moins chères en premier"`. Workflow :
`search` (`source.page`, `url: "https://www.leboncoin.fr/recherche?text={input}"`) → `extraire` (`code`, qui
rend `{ annonces: [{ title, prix, ville, url }] }`, `prix` en nombre) → `output` (`to: "page"`).
