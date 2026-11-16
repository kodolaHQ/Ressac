# Actions: workflows launched on demand

An action is a workflow **without a widget**, which the user launches whenever they want (from the new tab's
field, the « Actions » page of the sidebar, the builder or you) and whose result is a
**page** `ressac://action/<id>`. **Only create or change an action when the user asks you to.**
Actions do not exist in a private space.

An action is a `/workspace/actions/<id>/` folder (`<id>`: lowercase letters, digits and hyphens, 60 at most):
`action.json`, `workflow.json` and the `.mjs` files of its `code` blocks (same format as a widget's workflow:
same blocks, same rules, same templates, see « Widget workflows » in `/workspace/guides/widgets.md`).
Each run gets a copy of the folder's top-level files (no subfolders): 1 MB per file, 4 MB in all, otherwise the
run fails; keep samples and captures elsewhere.

`action.json` (never written by Ressac, only by you and the user):
`{ "name": "GitLab tickets", "description": "…", "keywords": ["gitlab", "tickets"], "input": { "label": "Search" }, "sources": { "account": [], "public": [], "web": false }, "layout": "…", "maxDurationMinutes": 5 }`

- `name` (1 to 60 characters) is the only one required.
- `description` (200 at most) and `keywords` (10 at most, 30 characters each) help the user find
  the action from the new tab's field.
- `input: { "label": "…" }` (40 characters at most): the action asks the user for a text at launch.
- `sources`: as in `widget.json` (`account`, `public`, `web`). With `account`, the user must grant
  reading with their account, and `web` is refused. **An action that searches the web (`web.search`,
  `ressac.searchWeb`) must declare `"web": true` in `sources`**, otherwise the `web.search` block is refused
  at validation and `searchWeb` fails at run time.
- `layout` (1,000 characters at most): your presentation instruction for the AI (see below).
- `maxDurationMinutes` (1 to 60): as for a harvest (see « Watches » in `/workspace/guides/widgets.md`).
- **No scheduling** (neither `harvest` nor `config`): an action only runs when launched.
- Its data, runs, results, memory and grants are kept outside your workspace.

An action's `workflow.json`:

- Its `output` block is **mandatory** and is `to: "page"` (widgets have `to: "widget"`, never the reverse);
  no `live`. Its value becomes the page's **results**.
- With `input` declared, `{input}` is the user's text in the templates (`url`, `query`, `question`,
  `text`, `prompt`), and a `code` block reads it in `ressac.input`. Without `input` declared, `{input}`
  gives a warning.
- **Read-only**, like a widget: an action does not click, does not type, sends nothing online.
- The user sees the result in the page, and the previous ones in the header's « previous results ».
- You launch them with `launch_action(id, input?)` and read the runs with `action_runs(id, run?)`
  (see « Browser tools » in AGENTS.md). The same privacy rules as for widgets apply: an
  action with `account` asks for the user's grant (key `action:<id>`), and without it you only see the statuses.
- `open_workflow` returns `{ action, block }` when the builder shows an action.

### The page: the AI composes it at each launch

At the end of the workflow, Ressac asks the AI (the user's Claude Code or Codex account) to **compose the page** from your results: it
picks components and fills them **by reference** to the results, Ressac checks, computes and draws.
Without the AI, or if its plan is refused, a simple fallback layout is used (labelled « simple
layout »). What matters for you: **return clean results**.

- Simple fields (texts, numbers, lists of flat objects), clear names (`title`, `prix`, `ville`,
  `project`, `url`), **full URLs** (`https://…`, never relative). Lists are cut at 200 items.
- `layout` tells the AI what the user wants to see (« a key figure, the tickets by priority, the three most
  urgent ones in a box »). It stays a presentation instruction, not data.
- A computation richer than the operations below (average, join, formatting) is done in a `code` block
  of the workflow, not in the page.
- Nothing leaves through the page: links are only http(s) addresses read as is from the results
  (never composed, never local), images only in https read from the results, and **never an image
  for an action with `account`**. An image only appears if its https address is in the
  results as is (`source.page` only returns text and links: never make up an image address). Everything is shown
  as text.

The built-in components and the references are in the « Page components » section of AGENTS.md.

### The agent's components

**Only when you create or change an action**, and the built-in components are not enough, you can
add a component in `/workspace/components/<name>/` (`<name>`: lowercase letters, digits, hyphens, 40 at most,
different from a built-in component) with two files:

- `component.json`: `{ "name": "barres", "description": "Bar chart", "properties": { "values": { "kind": "reference", "description": "List of { label, value }", "required": true }, "title": { "kind": "text", "description": "Chart title" } } }`. The component's `description`: 1 to 300 characters. `kind`: `reference`, `field`, `text`, `number` or `checkbox`;
  12 properties at most; each property has a mandatory `description` (1 to 200 characters) and a name
  `[a-zA-Z][a-zA-Z0-9_]*` of 40 characters at most. `name` is the folder's. No other key.
- `component.html` (256 KB at most): a complete page. It runs in an isolated frame: **no network, only
  `data:` images, no links**. It receives `window.postMessage({ type: "component", props, theme, width })`
  (`theme`: `"light"` or `"dark"`, `props`: the resolved values) and must answer
  `parent.postMessage({ type: "height", px }, "*")` to give its height (20 to 2,000). Any text received
  is data: show it with `textContent`, never `innerHTML`.
- The style follows Ressac's Aura brand: use the CSS variables set on the component's root
  (`--text`, `--text-muted`, `--accent`, `--accent-ink`, `--bg`, `--sheet`, `--glass`, `--border`, `--a1`, `--a2`, `--a3`,
  `--font-display`, `--font-ui`, `--font-mono`, `--radius-card`, `--radius-control`), with a fallback value, transparent
  background; no purple-blue gradient and no gradient text.

Full example, an SVG bar chart without a library (`components/barres/component.html`):

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

The AI sees your components (name, description, properties) and places them like the built-in ones; a
`reference` property arrives resolved in `props`. A broken component is reported to the user, it does not stop the page.

### Two action examples

**GitLab tickets, with an account.** `action.json`: `name: "GitLab tickets"`,
`sources: { "account": ["gitlab.com"] }`,
`layout: "a key figure, the tickets by priority, the three most urgent ones in a box"`. Workflow:
`tickets` (`source.page`, `url` of the tickets dashboard, `account: true`) → `extraire` (`code`,
`extraire.mjs`, which reads the page's text and `links` and returns `{ tickets: [{ title, project, priorite, url }] }`)
→ `output` (`to: "page"`). No image (action with an account), the user's grant is asked at the first launch.

**Leboncoin, with an input.** `action.json`: `name: "Leboncoin listings"`, `input: { "label": "Search" }`,
`sources: { "web": true }`, `layout: "cards with the price and the city, cheapest first"`. Workflow:
`search` (`source.page`, `url: "https://www.leboncoin.fr/recherche?text={input}"`) → `extraire` (`code`, which
returns `{ annonces: [{ title, prix, ville, url }] }`, `prix` as a number) → `output` (`to: "page"`).
