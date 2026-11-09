// WebAiOs: guard of the service worker and the pages of the agent's extensions (DNR, scripting, tabs, context).
// Loaded before the original script by webaios-fond.js and as the first script of each HTML page (classic script or
// module: no top-level declaration, except the `__webaiosFichiers` table that the copy writes at the top). Task 12 of plan 12 (task 13 adds the frame guard to it).
//
// - Dynamic and session DNR rules: `redirect`, `modifyHeaders`, `regexSubstitution`, `transform` refused.
// - `tabs.create`, `tabs.update`, `windows.create`: the address is first submitted to the main process
//   (`globalThis.__webaios.urlPermise`, set by the fixes' preload), which checks again on opening.
// - `scripting.executeScript` / `insertCSS`, `tabs.executeScript` / `insertCSS`: the target tab must be a tab
//   view (`__webaios.estOnglet`: never an invisible read) and a site of the granted hosts (`__webaios.hotePermis`);
//   these native calls have no other checkpoint. `target.documentIds` is refused (the guard would not know which
//   tab is targeted), `world: "MAIN"` too (out of reach of the page guard). The named files must be, byte
//   for byte, agent files listed by the copy (`__webaiosFichiers`, written at the top of this file): no
//   `..`, no absolute path, no WebAiOs file. `executeScript` (and `tabs.executeScript`) first injects
//   `webaios-correctifs-page.js`, `webaios-garde-page.js` and `webaios-portee.js`; with `func`, these files first,
//   then the function in the documents that received them (`documentIds` returned by the first call; a missing id:
//   refusal, no fallback).
// - `scripting.registerContentScripts` / `updateContentScripts`: like the copied manifest's entries, they only register
//   the guards then markers (`webaios-fichiers/<n>.js`, CSS first); `getRegisteredContentScripts` returns the
//   agent's files, and an update of only one of `js` / `css` takes the other from the current registration.
// - `runtime.onMessage`: in the service worker only (an open page of the extension would inject a second
//   time), answers `{ webaios: "contexte", fichiers }` (the page guard) with `{ onglet }`; if it is a tab, first injects, through the captured native functions, the CSS then the JS (guards first) of these markers into the
//   exact document of the sender (`documentIds`, otherwise its frame). The extension's listeners never see this
//   message (they cannot answer in the guard's place).
// - WebRTC removed.
// The original functions are kept nowhere the extension could take them back, and the replaced
// properties can no longer be rewritten or deleted. The arguments are frozen (copied) before being checked.
//
// The extension then runs in the same world and can modify the base objects (`Promise.prototype.then`,
// `Function.prototype.apply`, `Array.isArray`, the list iterator, `Object.prototype`…): everything the guard
// uses is captured at load, calls go through `Reflect.apply`, loops are indexed (no `for…of`, no
// spread, no `async`/`await` on what the extension provides), and the object copies have no prototype.
(() => {
  const g = globalThis;
  const appliquer = Reflect.apply;
  const P = Promise;
  const alors = Promise.prototype.then;
  const estListe = Array.isArray;
  const cles = Object.keys;
  const definir = Object.defineProperty;
  const descripteur = Object.getOwnPropertyDescriptor;
  const creer = Object.create;
  const Erreur = Error;
  const journal = console.error;

  const NOMS_RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  for (let i = 0; i < NOMS_RTC.length; i++) {
    try {
      delete g[NOMS_RTC[i]];
    } catch {
      // Non-configurable: the view's WebRTC policy cuts direct UDP.
    }
  }
  const c = g.chrome;
  const w = g.__webaios;
  if (!c) return;
  // Captured now: the extension can no longer replace them afterwards for the guard.
  const urlPermiseNatif = w && typeof w.urlPermise === "function" ? w.urlPermise : null;
  const hotePermisNatif = w && typeof w.hotePermis === "function" ? w.hotePermis : null;
  const estOngletNatif = w && typeof w.estOnglet === "function" ? w.estOnglet : null;
  const WM = WeakMap;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const prototypeDe = Object.getPrototypeOf;
  const ProtoObjet = Object.prototype;
  const entier = Number.isInteger;
  // Only the service worker answers the page guard and injects: an open page of the extension (popup, options)
  // would also receive the message, and inject a second time. Captured before any extension script.
  const SWGS = g.ServiceWorkerGlobalScope;
  const estFond = typeof SWGS === "function" ? g instanceof SWGS : typeof g.document === "undefined" || (!!g.location && g.location.pathname === "/_generated_background_page.html");

  const figer = (objet, nom, valeur) => {
    try {
      definir(objet, nom, { __proto__: null, value: valeur, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      appliquer(journal, console, [`[webaios] garde non posé sur ${nom} :`, e]);
    }
  };

  /** Original `then` on a promise (or a plain value: `ok` right away). */
  const ensuite = (v, ok, ko) => {
    if (v !== null && (typeof v === "object" || typeof v === "function")) {
      try {
        appliquer(alors, v, [ok, ko]);
        return;
      } catch {
        // Not an original promise: treated as a value.
      }
    }
    ok(v);
  };

  /** Rejects (promise) or passes the error to the callback, `chrome.runtime.lastError` set during the call, like Chrome. */
  const refuser = (message, rappel) => {
    if (typeof rappel !== "function") return new P((_ok, ko) => ko(new Erreur(message)));
    const runtime = c.runtime;
    const avant = runtime && descripteur(runtime, "lastError");
    try {
      if (runtime) definir(runtime, "lastError", { __proto__: null, value: { message }, configurable: true, enumerable: true, writable: true });
      rappel();
    } finally {
      if (runtime) {
        if (avant) definir(runtime, "lastError", avant);
        else delete runtime.lastError;
      }
    }
    return undefined;
  };

  const MAX_LISTE = 5000;
  /** An own property read only once through its descriptor (never through the prototype); absent: `trou`. */
  const TROU = creer(null);
  const lirePropre = (v, k) => {
    const d = descripteur(v, k);
    if (!d) return TROU;
    // The descriptor's fields read as own: `Object.prototype.value` or `.get` added change nothing here.
    const valeur = descripteur(d, "value");
    if (valeur) return valeur.value;
    const lire = descripteur(d, "get");
    return lire && typeof lire.value === "function" ? appliquer(lire.value, v, []) : undefined;
  };
  const poser = (copie, k, valeur) =>
    definir(copie, k, { __proto__: null, value: valeur, writable: true, enumerable: true, configurable: true });
  /**
   * Deep copy read only once: objects copied without a prototype (nothing is inherited); lists copied dense
   * (`length` read once, at most 5000 items, each read through its own descriptor: a list with holes is refused,
   * since the native API would read the hole in `Array.prototype`); functions and plain values kept
   * (`scripting.executeScript({ func })`). A cycle or a depth > 32: refusal.
   */
  const copier = (v, profondeur, chemin) => {
    if (v === null || typeof v !== "object") return v;
    if (profondeur > 32) throw new Erreur("arguments trop imbriqués");
    for (let i = 0; i < chemin.length; i++) if (chemin[i] === v) throw new Erreur("arguments en boucle");
    chemin[chemin.length] = v;
    let copie;
    if (estListe(v)) {
      const n = lirePropre(v, "length");
      if (typeof n !== "number" || n > MAX_LISTE) throw new Erreur("tableau trop long");
      copie = [];
      for (let i = 0; i < n; i++) {
        const e = lirePropre(v, `${i}`);
        if (e === TROU) throw new Erreur("tableau à trous");
        poser(copie, i, copier(e, profondeur + 1, chemin));
      }
    } else {
      copie = creer(null);
      const k = cles(v);
      for (let i = 0; i < k.length; i++) {
        const e = lirePropre(v, k[i]);
        if (e !== TROU) poser(copie, k[i], copier(e, profondeur + 1, chemin));
      }
    }
    chemin.length = chemin.length - 1;
    return copie;
  };

  /**
   * Calls `f` if `verifier(args)` returns true (or a promise of true), otherwise refuses with `message(args)`; promise or
   * callback, like the original call. The arguments are copied only once: the copy is checked then passed to the API.
   */
  const garder = (f, cible, verifier, message, prefixe = "Arguments refusés par WebAiOs", o = {}) =>
    function (...tous) {
      // The possible callback: the last argument, if it is a function.
      let n = tous.length;
      const rappel = n > 0 && typeof tous[n - 1] === "function" ? tous[n - 1] : undefined;
      if (rappel) n--;
      let args;
      try {
        args = copier(tous, 0, []);
        args.length = n;
        // Adaptation of the copied arguments (guard files first…); an error is a refusal.
        if (o.preparer) o.preparer(args);
      } catch (e) {
        return refuser(`${prefixe} (${e && e.message})`, rappel);
      }
      const appeler = () => {
        if (!o.appel) {
          if (rappel) args[args.length] = rappel;
          return appliquer(f, cible, args);
        }
        // Composed call (promises): the callback receives its result, or the refusal with lastError.
        const r = o.appel(args);
        if (!rappel) return r;
        ensuite(r, (v) => rappel(v), (e) => refuser(`${e && e.message}`, rappel));
        return undefined;
      };
      return new P((ok, ko) => {
        const echec = (e) => {
          const r = refuser(typeof e === "string" ? e : `${e && e.message}`, rappel);
          if (rappel) ok(undefined);
          else ensuite(r, ok, ko);
        };
        let verdict;
        try {
          verdict = verifier(args);
        } catch (e) {
          echec(e);
          return;
        }
        ensuite(
          verdict,
          (permis) => {
            if (permis !== true) {
              echec(typeof permis === "string" ? permis : message(args));
              return;
            }
            let r;
            try {
              r = appeler();
            } catch (e) {
              ko(e);
              return;
            }
            ensuite(r, ok, ko);
          },
          echec,
        );
      });
    };

  const URL_REFUSEE = "URL refusée par WebAiOs";
  const SITE_REFUSE = "Site refusé par WebAiOs";
  /** A (original) promise of true if the main process allows it; false without preload. */
  const demander = (natif, valeur) =>
    new P((ok) => {
      if (!natif) return ok(false);
      let r;
      try {
        r = appliquer(natif, w, [valeur]);
      } catch {
        return ok(false);
      }
      ensuite(r, (v) => ok(v === true), () => ok(false));
    });
  const urlPermise = (url) => demander(urlPermiseNatif, `${url}`);
  const hotePermis = (onglet) => demander(hotePermisNatif, onglet);
  const estOnglet = (onglet) => demander(estOngletNatif, onglet);
  /** All the promises of true, one after the other (without `Promise.all`, which can be replaced). */
  const toutes = (liste) =>
    new P((ok) => {
      let i = 0;
      const suivante = () => {
        if (i >= liste.length) return ok(true);
        ensuite(urlPermise(liste[i++]), (v) => (v ? suivante() : ok(false)), () => ok(false));
      };
      suivante();
    });

  // --- DNR rules
  const dnr = c.declarativeNetRequest;
  if (dnr) {
    const actionRefusee = (options) => {
      const regles = options && estListe(options.addRules) ? options.addRules : [];
      for (let i = 0; i < regles.length; i++) {
        const r = regles[i];
        const action = r && r.action;
        const type = action && action.type;
        if (type === "redirect" || type === "modifyHeaders") return type;
        const redirection = action && action.redirect;
        if (redirection && redirection.regexSubstitution !== undefined) return "regexSubstitution";
        if (redirection && redirection.transform !== undefined) return "transform";
      }
      return null;
    };
    const NOMS_DNR = ["updateDynamicRules", "updateSessionRules"];
    for (let i = 0; i < NOMS_DNR.length; i++) {
      const f = dnr[NOMS_DNR[i]];
      if (typeof f !== "function") continue;
      figer(
        dnr,
        NOMS_DNR[i],
        garder(
          f,
          dnr,
          (args) => actionRefusee(args[0]) === null,
          (args) => `Règle DNR refusée par WebAiOs (${actionRefusee(args[0])})`,
          "Règle DNR refusée par WebAiOs",
        ),
      );
    }
    figer(c, "declarativeNetRequest", dnr);
  }

  // --- Opened addresses
  const tabs = c.tabs;
  if (tabs) {
    if (typeof tabs.create === "function") {
      figer(tabs, "create", garder(tabs.create, tabs, (args) => !(args[0] && args[0].url) || urlPermise(args[0].url), () => URL_REFUSEE));
    }
    if (typeof tabs.update === "function") {
      const proprietes = (args) => (typeof args[0] === "object" && args[0] !== null ? args[0] : args[1]);
      figer(
        tabs,
        "update",
        garder(
          tabs.update,
          tabs,
          (args) => {
            const p = proprietes(args);
            return !(p && p.url) || urlPermise(p.url);
          },
          () => URL_REFUSEE,
        ),
      );
    }
  }
  const windows = c.windows;
  if (windows && typeof windows.create === "function") {
    figer(
      windows,
      "create",
      garder(
        windows.create,
        windows,
        (args) => {
          const d = args[0];
          return toutes(d && d.url ? (estListe(d.url) ? d.url : [d.url]) : []);
        },
        () => URL_REFUSEE,
      ),
    );
    figer(c, "windows", windows);
  }

  // --- Scripts and styles placed in a tab
  const ONGLET_REFUSE = "Onglet refusé par WebAiOs";
  const GARDES_PAGE = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-portee.js"];
  const REPERES = "webaios-fichiers/";
  // The table written by the copy at the top of this file: every .js and .css of the agent, the index is its marker. The
  // paths are compared as they are to this list (key in an object without a prototype): no splitting, no
  // normalization by a method the extension could replace. Without a table (outside the copy), no file is allowed.
  // eslint-disable-next-line no-undef
  const tableBrute = typeof __webaiosFichiers !== "undefined" && estListe(__webaiosFichiers) ? __webaiosFichiers : [];
  // Without a prototype, and read only for an integer within its bounds: an index outside the table never reads
  // `Object.prototype` or `Array.prototype` (which the extension can fill).
  const table = creer(null);
  let tailleTable = 0;
  const entreeDe = (n) => (typeof n === "number" && entier(n) && n >= 0 && n < tailleTable ? table[n] : undefined);
  const indices = creer(null);
  const reperes = creer(null);
  for (let i = 0; i < tableBrute.length; i++) {
    const e = tableBrute[i];
    if (!estListe(e) || typeof e[0] !== "string" || (e[1] !== "js" && e[1] !== "css")) continue;
    const n = tailleTable++;
    table[n] = { __proto__: null, chemin: e[0], genre: e[1] };
    indices[`${e[1]}:${e[0]}`] = n;
    reperes[`${REPERES}${n}.js`] = n;
  }
  const estGardePage = (p) => p === GARDES_PAGE[0] || p === GARDES_PAGE[1] || p === GARDES_PAGE[2];
  /** The index of a file of the table, of this kind; throws "fichier refusé : …" otherwise. */
  const indiceDe = (genre, p) => {
    const n = typeof p === "string" ? indices[`${genre}:${p}`] : undefined;
    if (typeof n !== "number") throw new Erreur(`fichier refusé : ${typeof p === "string" ? p : typeof p}`);
    return n;
  };
  /** The paths of a list (copied), checked against the table. */
  const fichiersPermis = (genre, liste) => {
    if (!estListe(liste)) throw new Erreur("liste de fichiers attendue");
    const r = [];
    for (let i = 0; i < liste.length; i++) {
      indiceDe(genre, liste[i]);
      r[r.length] = liste[i];
    }
    return r;
  };
  const requete = tabs && typeof tabs.query === "function" ? tabs.query : null;
  /** True if tab `id` is a tab view (never an invisible read) of a granted site; otherwise the refusal. */
  const verdictOnglet = (id) =>
    new P((ok) => {
      ensuite(
        estOnglet(id),
        (onglet) => {
          if (!onglet) return ok(ONGLET_REFUSE);
          ensuite(hotePermis(id), (v) => ok(v ? true : SITE_REFUSE), () => ok(SITE_REFUSE));
        },
        () => ok(ONGLET_REFUSE),
      );
    });
  /** The targeted tab: the one given, otherwise the active tab of the current window (like Chrome). */
  const ongletPermis = (id) =>
    new P((ok) => {
      if (typeof id === "number") return ensuite(verdictOnglet(id), ok, () => ok(false));
      if (!requete) return ok(false);
      let r;
      try {
        r = appliquer(requete, tabs, [{ active: true, currentWindow: true }]);
      } catch {
        return ok(false);
      }
      ensuite(
        r,
        (liste) => {
          const actif = liste && liste[0];
          if (!actif || typeof actif.id !== "number") return ok(false);
          ensuite(verdictOnglet(actif.id), ok, () => ok(false));
        },
        () => ok(false),
      );
    });
  /** The guard's files, then `liste` (dense copy). */
  const gardesPuis = (liste) => {
    const r = [];
    for (let i = 0; i < GARDES_PAGE.length; i++) r[r.length] = GARDES_PAGE[i];
    for (let i = 0; i < liste.length; i++) r[r.length] = liste[i];
    return r;
  };
  const mondeIsole = (d) => {
    if (d.world !== undefined && d.world !== "ISOLATED") throw new Erreur(`world ${d.world}`);
  };
  /** The copied details of executeScript / insertCSS: a target with a tab, never documentIds. */
  const ciblePropre = (args) => {
    const d = args[0];
    if (d === null || typeof d !== "object") throw new Erreur("détails absents");
    const t = d.target;
    if (t === null || typeof t !== "object") throw new Erreur("cible absente");
    if (t.documentIds !== undefined) throw new Erreur("documentIds");
    mondeIsole(d);
    return d;
  };
  const verifierCible = (args) => (typeof args[0].target.tabId === "number" ? ongletPermis(args[0].target.tabId) : SITE_REFUSE);
  /** The ids of the documents returned by executeScript: all of them, or null (a single missing one is enough). */
  const documentsDe = (resultats) => {
    if (!estListe(resultats)) return null;
    const n = lirePropre(resultats, "length");
    if (typeof n !== "number" || n === 0 || n > MAX_LISTE) return null;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const r = lirePropre(resultats, `${i}`);
      const id = r !== null && typeof r === "object" ? lirePropre(r, "documentId") : TROU;
      if (typeof id !== "string") return null;
      ids[ids.length] = id;
    }
    return ids;
  };
  /** The markers (CSS then JS) of a registered script, after the guards. */
  const reperesDe = (css, js) => {
    const r = [];
    for (let i = 0; i < css.length; i++) r[r.length] = `${REPERES}${indiceDe("css", css[i])}.js`;
    for (let i = 0; i < js.length; i++) r[r.length] = `${REPERES}${indiceDe("js", js[i])}.js`;
    return gardesPuis(r);
  };
  /** What the agent had registered (`js`, `css`) according to the real list (guards and markers), read as own. */
  const decoder = (liste) => {
    const vu = { __proto__: null, js: [], css: [] };
    if (!estListe(liste)) return vu;
    const n = lirePropre(liste, "length");
    for (let i = 0; typeof n === "number" && i < n && i < MAX_LISTE; i++) {
      const p = lirePropre(liste, `${i}`);
      if (typeof p !== "string" || estGardePage(p)) continue;
      const k = reperes[p];
      if (typeof k !== "number") continue;
      const e = entreeDe(k);
      if (!e) continue;
      vu[e.genre][vu[e.genre].length] = e.chemin;
    }
    return vu;
  };
  const scripting = c.scripting;
  // On Firefox (the only one with getBrowserInfo), one executeScript per file: Firefox drops a whole call when one of
  // its files fails to compile, Chromium only that file. Same world either way.
  const unParFichier = !!c.runtime && typeof c.runtime.getBrowserInfo === "function";
  // Captured before being replaced: the background uses them to inject the content scripts' files.
  const executerNatif = scripting && typeof scripting.executeScript === "function" ? scripting.executeScript : null;
  const cssNatif = scripting && typeof scripting.insertCSS === "function" ? scripting.insertCSS : null;
  if (scripting) {
    if (executerNatif) {
      const executer = executerNatif;
      figer(
        scripting,
        "executeScript",
        garder(executer, scripting, verifierCible, () => SITE_REFUSE, undefined, {
          preparer: (args) => {
            const d = ciblePropre(args);
            if (d.files !== undefined) d.files = gardesPuis(fichiersPermis("js", d.files));
          },
          appel: (args) => {
            const d = args[0];
            if (d.func === undefined) return appliquer(executer, scripting, [d]);
            // The guard first, then the function in the documents that received it (a navigation between the two
            // does not make it run elsewhere); a document without an id: refusal.
            const premier = creer(null);
            premier.target = d.target;
            premier.files = gardesPuis([]);
            if (d.injectImmediately !== undefined) premier.injectImmediately = d.injectImmediately;
            return new P((ok, ko) => {
              let r;
              try {
                r = appliquer(executer, scripting, [premier]);
              } catch (e) {
                return ko(e);
              }
              ensuite(
                r,
                (resultats) => {
                  const ids = documentsDe(resultats);
                  if (!ids) return ko(new Erreur("Arguments refusés par WebAiOs (documentId absent)"));
                  const t = creer(null);
                  t.tabId = d.target.tabId;
                  t.documentIds = ids;
                  d.target = t;
                  let r2;
                  try {
                    r2 = appliquer(executer, scripting, [d]);
                  } catch (e) {
                    return ko(e);
                  }
                  ensuite(r2, ok, ko);
                },
                ko,
              );
            });
          },
        }),
      );
    }
    const NOMS_CSS = ["insertCSS", "removeCSS"];
    for (let i = 0; i < NOMS_CSS.length; i++) {
      const f = scripting[NOMS_CSS[i]];
      if (typeof f !== "function") continue;
      figer(
        scripting,
        NOMS_CSS[i],
        garder(f, scripting, verifierCible, () => SITE_REFUSE, undefined, {
          preparer: (args) => {
            const d = ciblePropre(args);
            if (d.files !== undefined) d.files = fichiersPermis("css", d.files);
          },
        }),
      );
    }
    /** A registered script: never in the page's world; its files, checked, become guards + markers. */
    const scriptsCopies = (args) => {
      const liste = args[0];
      if (!estListe(liste)) throw new Erreur("liste de scripts attendue");
      for (let j = 0; j < liste.length; j++) {
        const s = liste[j];
        if (s === null || typeof s !== "object") throw new Erreur("script illisible");
        mondeIsole(s);
        if (s.js !== undefined) fichiersPermis("js", s.js);
        if (s.css !== undefined) fichiersPermis("css", s.css);
      }
      return liste;
    };
    const reecrire = (s, actuel) => {
      if (s.js === undefined && s.css === undefined) return;
      s.js = reperesDe(s.css !== undefined ? s.css : actuel.css, s.js !== undefined ? s.js : actuel.js);
      delete s.css;
    };
    const VIDE = { __proto__: null, js: [], css: [] };
    const enregistrer = scripting.registerContentScripts;
    if (typeof enregistrer === "function") {
      figer(
        scripting,
        "registerContentScripts",
        garder(enregistrer, scripting, () => true, () => SITE_REFUSE, undefined, {
          preparer: (args) => {
            const liste = scriptsCopies(args);
            for (let j = 0; j < liste.length; j++) reecrire(liste[j], VIDE);
          },
        }),
      );
    }
    const lireEnregistres = scripting.getRegisteredContentScripts;
    const mettreAJour = scripting.updateContentScripts;
    if (typeof mettreAJour === "function") {
      figer(
        scripting,
        "updateContentScripts",
        garder(mettreAJour, scripting, () => true, () => SITE_REFUSE, undefined, {
          preparer: scriptsCopies,
          // Only one of `js` / `css` given: the other is taken from the current registration (it is made of markers).
          appel: (args) => {
            const liste = args[0];
            const ids = [];
            for (let j = 0; j < liste.length; j++) {
              const s = liste[j];
              if ((s.js === undefined) !== (s.css === undefined)) ids[ids.length] = s.id;
            }
            const finir = (actuels) => {
              for (let j = 0; j < liste.length; j++) reecrire(liste[j], actuels[`${liste[j].id}`] || VIDE);
              return appliquer(mettreAJour, scripting, [liste]);
            };
            if (ids.length === 0 || typeof lireEnregistres !== "function") return finir(creer(null));
            return new P((ok, ko) => {
              ensuite(
                appliquer(lireEnregistres, scripting, [{ ids }]),
                (lus) => {
                  const actuels = creer(null);
                  const n = estListe(lus) ? lirePropre(lus, "length") : 0;
                  for (let i = 0; typeof n === "number" && i < n && i < MAX_LISTE; i++) {
                    const x = lirePropre(lus, `${i}`);
                    const id = x !== null && typeof x === "object" ? lirePropre(x, "id") : TROU;
                    if (typeof id === "string") actuels[id] = decoder(lirePropre(x, "js"));
                  }
                  let r;
                  try {
                    r = finir(actuels);
                  } catch (e) {
                    return ko(e);
                  }
                  ensuite(r, ok, ko);
                },
                ko,
              );
            });
          },
        }),
      );
    }
    if (typeof lireEnregistres === "function") {
      // Returns the agent's files (and not the guards and the markers): the round trip to updateContentScripts works.
      figer(
        scripting,
        "getRegisteredContentScripts",
        garder(lireEnregistres, scripting, () => true, () => SITE_REFUSE, undefined, {
          appel: (args) =>
            new P((ok, ko) => {
              ensuite(
                appliquer(lireEnregistres, scripting, args.length > 0 && args[0] !== undefined ? [args[0]] : []),
                (lus) => {
                  const r = [];
                  const n = estListe(lus) ? lirePropre(lus, "length") : 0;
                  for (let i = 0; typeof n === "number" && i < n && i < MAX_LISTE; i++) {
                    const x = lirePropre(lus, `${i}`);
                    if (x === null || typeof x !== "object") continue;
                    const y = {};
                    const k = cles(x);
                    for (let j = 0; j < k.length; j++) if (k[j] !== "js" && k[j] !== "css") poser(y, k[j], lirePropre(x, k[j]));
                    const vu = decoder(lirePropre(x, "js"));
                    if (vu.js.length > 0) poser(y, "js", vu.js);
                    if (vu.css.length > 0) poser(y, "css", vu.css);
                    r[r.length] = y;
                  }
                  ok(r);
                },
                ko,
              );
            }),
        }),
      );
    }
    figer(c, "scripting", scripting);
  }
  if (tabs) {
    // MV2 (absent in MV3): the tab is checked; executeScript first passes the page guards into the same
    // frames, and only accepts a file of the table.
    const detailsDe = (args) => (typeof args[0] === "number" || args[0] === undefined || args[0] === null ? args[1] : args[0]);
    const verifierOnglet = (args) => ongletPermis(typeof args[0] === "number" ? args[0] : undefined);
    const executerOnglet = tabs.executeScript;
    if (typeof executerOnglet === "function") {
      figer(
        tabs,
        "executeScript",
        garder(executerOnglet, tabs, verifierOnglet, () => SITE_REFUSE, undefined, {
          preparer: (args) => {
            const d = detailsDe(args);
            if (d === null || typeof d !== "object") throw new Erreur("détails absents");
            if (d.file !== undefined) indiceDe("js", d.file);
          },
          appel: (args) =>
            new P((ok, ko) => {
              const d = detailsDe(args);
              let i = 0;
              const suivant = () => {
                if (i >= GARDES_PAGE.length) {
                  let r;
                  try {
                    r = appliquer(executerOnglet, tabs, args);
                  } catch (e) {
                    return ko(e);
                  }
                  return ensuite(r, ok, ko);
                }
                const g = creer(null);
                g.file = GARDES_PAGE[i++];
                const k = cles(d);
                for (let j = 0; j < k.length; j++) if (k[j] !== "file" && k[j] !== "code") g[k[j]] = d[k[j]];
                let r;
                try {
                  r = appliquer(executerOnglet, tabs, typeof args[0] === "number" ? [args[0], g] : [g]);
                } catch (e) {
                  return ko(e);
                }
                ensuite(r, suivant, ko);
              };
              suivant();
            }),
        }),
      );
    }
    const cssOnglet = tabs.insertCSS;
    if (typeof cssOnglet === "function") figer(tabs, "insertCSS", garder(cssOnglet, tabs, verifierOnglet, () => SITE_REFUSE));
    figer(c, "tabs", tabs);
  }

  // --- Content scripts context (page guard)
  const runtime = c.runtime;
  const onMessage = runtime && runtime.onMessage;
  if (onMessage && typeof onMessage.addListener === "function") {
    const estContexte = (m) => {
      if (m === null || typeof m !== "object") return false;
      const d = descripteur(m, "webaios");
      return !!d && descripteur(d, "value") !== undefined && d.value === "contexte";
    };
    // The first listener: set before any extension script, in the service worker only. In a page, the
    // message is only hidden from the extension's listeners (below), with no answer.
    if (estFond) appliquer(onMessage.addListener, onMessage, [
      (m, expediteur, repondre) => {
        if (!estContexte(m)) return undefined;
        const reponse = (v) => {
          try {
            repondre({ onglet: v === true });
          } catch {
            // The content script is gone.
          }
        };
        const refuser = () => {
          reponse(false);
          return false;
        };
        const exp = expediteur !== null && typeof expediteur === "object" ? expediteur : creer(null);
        const onglet = lirePropre(exp, "tab");
        const id = onglet !== null && typeof onglet === "object" ? lirePropre(onglet, "id") : TROU;
        // The requested markers: indexes of the table, CSS and JS separate in their order.
        const css = [];
        const js = [];
        const demandes = lirePropre(m, "fichiers");
        if (demandes !== TROU && demandes !== undefined) {
          let liste;
          try {
            liste = copier(demandes, 0, []);
          } catch {
            liste = null;
          }
          if (!estListe(liste)) return refuser();
          for (let i = 0; i < liste.length; i++) {
            const n = liste[i];
            const e = entreeDe(n);
            if (!e) return refuser();
            const l = e.genre === "css" ? css : js;
            l[l.length] = e.chemin;
          }
        }
        if (typeof id !== "number") return refuser();
        // The exact document that asked (otherwise its frame): a navigation in the meantime receives nothing there without a guard.
        const documentId = lirePropre(exp, "documentId");
        const cadre = lirePropre(exp, "frameId");
        const cible = creer(null);
        cible.tabId = id;
        if (typeof documentId === "string") cible.documentIds = [documentId];
        else if (typeof cadre === "number") cible.frameIds = [cadre];
        else if (css.length + js.length > 0) return refuser();
        const injecter = () =>
          new P((ok) => {
            const ko = (e) => {
              appliquer(journal, console, ["[webaios] fichiers des scripts de contenu non injectés :", e]);
              ok(true);
            };
            let i = 0;
            const scripts = () => {
              if (i >= js.length || !executerNatif) return ok(true);
              const d = creer(null);
              d.target = cible;
              if (unParFichier) d.files = gardesPuis([js[i++]]);
              else {
                d.files = gardesPuis(js);
                i = js.length;
              }
              d.injectImmediately = true;
              const suivant = (e) => {
                appliquer(journal, console, ["[webaios] fichiers des scripts de contenu non injectés :", e]);
                scripts();
              };
              try {
                ensuite(appliquer(executerNatif, scripting, [d]), () => scripts(), suivant);
              } catch (e) {
                suivant(e);
              }
            };
            if (css.length === 0 || !cssNatif) return scripts();
            const d = creer(null);
            d.target = cible;
            d.files = css;
            try {
              ensuite(appliquer(cssNatif, scripting, [d]), scripts, ko);
            } catch (e) {
              ko(e);
            }
          });
        ensuite(
          estOnglet(id),
          (v) => {
            if (v !== true) return reponse(false);
            ensuite(injecter(), () => reponse(true), () => reponse(true));
          },
          () => reponse(false),
        );
        return true;
      },
    ]);
    // The extension's listeners, wrapped: this message does not reach them. An event's methods are on its
    // prototype: each holder of the chain is replaced (only `onMessage` is filtered, the other events pass).
    const enveloppes = new WM();
    const envelopper = (f) => {
      let e = appliquer(wmGet, enveloppes, [f]);
      if (!e) {
        e = function (m, expediteur, repondre) {
          if (estContexte(m)) return undefined;
          return appliquer(f, this, [m, expediteur, repondre]);
        };
        appliquer(wmSet, enveloppes, [f, e]);
      }
      return e;
    };
    const NOMS_EVENEMENT = ["addListener", "removeListener", "hasListener"];
    const porteurs = [];
    for (let o = onMessage, n = 0; o !== null && o !== ProtoObjet && n < 16; o = prototypeDe(o), n++) porteurs[porteurs.length] = o;
    for (let i = porteurs.length - 1; i >= 0; i--) {
      const o = porteurs[i];
      for (let j = 0; j < NOMS_EVENEMENT.length; j++) {
        const nom = NOMS_EVENEMENT[j];
        const d = descripteur(o, nom);
        const natif = d && descripteur(d, "value") ? d.value : undefined;
        if (typeof natif !== "function") continue;
        figer(o, nom, function (f) {
          if (this !== onMessage || typeof f !== "function") return appliquer(natif, this, [f]);
          return appliquer(natif, this, [nom === "addListener" ? envelopper(f) : appliquer(wmGet, enveloppes, [f]) || f]);
        });
      }
    }
    // On the event itself too: the method found through the chain, wrapped.
    for (let j = 0; j < NOMS_EVENEMENT.length; j++) {
      const nom = NOMS_EVENEMENT[j];
      if (descripteur(onMessage, nom)) continue;
      const natif = onMessage[nom];
      if (typeof natif === "function") figer(onMessage, nom, natif);
    }
    figer(runtime, "onMessage", onMessage);
  }
})();
