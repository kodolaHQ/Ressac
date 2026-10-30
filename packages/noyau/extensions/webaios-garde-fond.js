// WebAiOs : garde du service worker et des pages des extensions de l'agent (DNR, scripting, tabs, contexte).
// Chargé avant le script d'origine par webaios-fond.js et en premier script de chaque page HTML (script classique ou
// module : aucune déclaration au niveau du fichier, sauf la table `__webaiosFichiers` que la copie écrit en tête). Tâche 12 du plan 12 (la tâche 13 y ajoute la garde des cadres).
//
// - Règles DNR dynamiques et de session : `redirect`, `modifyHeaders`, `regexSubstitution`, `transform` refusés.
// - `tabs.create`, `tabs.update`, `windows.create` : l'adresse est d'abord soumise au processus principal
//   (`globalThis.__webaios.urlPermise`, posé par le preload des correctifs), qui vérifie de nouveau à l'ouverture.
// - `scripting.executeScript` / `insertCSS`, `tabs.executeScript` / `insertCSS` : l'onglet visé doit être une vue
//   d'onglet (`__webaios.estOnglet` : jamais une lecture invisible) et un site des hôtes accordés (`__webaios.hotePermis`) ;
//   ces appels natifs n'ont pas d'autre point de contrôle. `target.documentIds` est refusé (le garde ne saurait pas quel
//   onglet est visé), `world: "MAIN"` aussi (hors de portée de la garde de page). Les fichiers nommés doivent être, à
//   l'octet près, des fichiers de l'agent listés par la copie (`__webaiosFichiers`, écrit en tête de ce fichier) : ni
//   `..`, ni chemin absolu, ni fichier de WebAiOs. `executeScript` (et `tabs.executeScript`) injecte d'abord
//   `webaios-correctifs-page.js`, `webaios-garde-page.js` et `webaios-portee.js` ; avec `func`, ces fichiers d'abord,
//   puis la fonction dans les documents qui les ont reçus (`documentIds` rendus par le premier appel ; un id manquant :
//   refus, sans repli).
// - `scripting.registerContentScripts` / `updateContentScripts` : comme les entrées du manifeste copié, n'enregistrent
//   que les gardes puis des repères (`webaios-fichiers/<n>.js`, CSS d'abord) ; `getRegisteredContentScripts` rend les
//   fichiers de l'agent, et une mise à jour d'un seul de `js` / `css` reprend l'autre de l'enregistrement actuel.
// - `runtime.onMessage` : dans le service worker seulement (une page ouverte de l'extension injecterait une seconde
//   fois), répond à `{ webaios: "contexte", fichiers }` (la garde de page) par `{ onglet }` ; si c'est un onglet, injecte d'abord, par les fonctions natives saisies, le CSS puis le JS (gardes en tête) de ces repères dans le
//   document exact de l'expéditeur (`documentIds`, sinon son cadre). Les écouteurs de l'extension ne voient jamais ce
//   message (ils ne peuvent pas répondre à la place du garde).
// - WebRTC retiré.
// Les fonctions d'origine ne sont gardées nulle part où l'extension pourrait les reprendre, et les propriétés
// remplacées ne sont plus ni réécrivables ni supprimables. Les arguments sont figés (copie) avant d'être vérifiés.
//
// L'extension tourne ensuite dans le même monde et peut modifier les objets de base (`Promise.prototype.then`,
// `Function.prototype.apply`, `Array.isArray`, l'itérateur des listes, `Object.prototype`…) : tout ce dont le garde se
// sert est saisi à son chargement, les appels passent par `Reflect.apply`, les boucles sont indexées (ni `for…of`, ni
// décomposition, ni `async`/`await` sur ce que fournit l'extension), et les copies d'objets n'ont pas de prototype.
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
      // Non configurable : la politique WebRTC de la vue coupe l'UDP direct.
    }
  }
  const c = g.chrome;
  const w = g.__webaios;
  if (!c) return;
  // Saisis maintenant : l'extension ne peut plus les remplacer ensuite pour le garde.
  const urlPermiseNatif = w && typeof w.urlPermise === "function" ? w.urlPermise : null;
  const hotePermisNatif = w && typeof w.hotePermis === "function" ? w.hotePermis : null;
  const estOngletNatif = w && typeof w.estOnglet === "function" ? w.estOnglet : null;
  const WM = WeakMap;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const prototypeDe = Object.getPrototypeOf;
  const ProtoObjet = Object.prototype;
  const entier = Number.isInteger;
  // Le service worker seul répond à la garde de page et injecte : une page de l'extension ouverte (popup, options)
  // recevrait aussi le message, et injecterait une seconde fois. Saisi avant tout script de l'extension.
  const SWGS = g.ServiceWorkerGlobalScope;
  const estFond = typeof SWGS === "function" ? g instanceof SWGS : typeof g.document === "undefined";

  const figer = (objet, nom, valeur) => {
    try {
      definir(objet, nom, { __proto__: null, value: valeur, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      appliquer(journal, console, [`[webaios] garde non posé sur ${nom} :`, e]);
    }
  };

  /** `then` d'origine sur une promesse (ou une valeur simple : `ok` tout de suite). */
  const ensuite = (v, ok, ko) => {
    if (v !== null && (typeof v === "object" || typeof v === "function")) {
      try {
        appliquer(alors, v, [ok, ko]);
        return;
      } catch {
        // Pas une promesse d'origine : traitée comme une valeur.
      }
    }
    ok(v);
  };

  /** Rejette (promesse) ou passe l'erreur au rappel, `chrome.runtime.lastError` posé pendant l'appel, comme Chrome. */
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
  /** Une propriété propre lue une seule fois par son descripteur (jamais par le prototype) ; absente : `trou`. */
  const TROU = creer(null);
  const lirePropre = (v, k) => {
    const d = descripteur(v, k);
    if (!d) return TROU;
    // Les champs du descripteur lus comme propres : `Object.prototype.value` ou `.get` ajoutés n'y changent rien.
    const valeur = descripteur(d, "value");
    if (valeur) return valeur.value;
    const lire = descripteur(d, "get");
    return lire && typeof lire.value === "function" ? appliquer(lire.value, v, []) : undefined;
  };
  const poser = (copie, k, valeur) =>
    definir(copie, k, { __proto__: null, value: valeur, writable: true, enumerable: true, configurable: true });
  /**
   * Copie profonde lue une seule fois : objets recopiés sans prototype (rien n'y est hérité) ; listes recopiées denses
   * (`length` lu une fois, au plus 5000 éléments, chacun lu par son descripteur propre : une liste à trous est refusée,
   * puisque l'API native lirait le trou dans `Array.prototype`) ; fonctions et valeurs simples gardées
   * (`scripting.executeScript({ func })`). Un cycle ou une profondeur > 32 : refus.
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
   * Appelle `f` si `verifier(args)` rend vrai (ou une promesse de vrai), sinon refuse avec `message(args)` ; promesse ou
   * rappel, comme l'appel d'origine. Les arguments sont copiés une seule fois : la copie est vérifiée puis passée à l'API.
   */
  const garder = (f, cible, verifier, message, prefixe = "Arguments refusés par WebAiOs", o = {}) =>
    function (...tous) {
      // Le rappel éventuel : le dernier argument, s'il est une fonction.
      let n = tous.length;
      const rappel = n > 0 && typeof tous[n - 1] === "function" ? tous[n - 1] : undefined;
      if (rappel) n--;
      let args;
      try {
        args = copier(tous, 0, []);
        args.length = n;
        // Adaptation des arguments copiés (fichiers de la garde en tête…) ; une erreur est un refus.
        if (o.preparer) o.preparer(args);
      } catch (e) {
        return refuser(`${prefixe} (${e && e.message})`, rappel);
      }
      const appeler = () => {
        if (!o.appel) {
          if (rappel) args[args.length] = rappel;
          return appliquer(f, cible, args);
        }
        // Appel composé (promesses) : le rappel reçoit son résultat, ou le refus avec lastError.
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
  /** Une promesse (d'origine) de vrai si le processus principal permet ; faux sans preload. */
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
  /** Toutes les promesses de vrai, l'une après l'autre (sans `Promise.all`, remplaçable). */
  const toutes = (liste) =>
    new P((ok) => {
      let i = 0;
      const suivante = () => {
        if (i >= liste.length) return ok(true);
        ensuite(urlPermise(liste[i++]), (v) => (v ? suivante() : ok(false)), () => ok(false));
      };
      suivante();
    });

  // --- Règles DNR
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

  // --- Adresses ouvertes
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

  // --- Scripts et styles posés dans un onglet
  const ONGLET_REFUSE = "Onglet refusé par WebAiOs";
  const GARDES_PAGE = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-portee.js"];
  const REPERES = "webaios-fichiers/";
  // La table écrite par la copie en tête de ce fichier : chaque .js et .css de l'agent, l'indice est son repère. Les
  // chemins sont comparés tels quels à cette liste (clé dans un objet sans prototype) : aucun découpage, aucune
  // normalisation par une méthode que l'extension pourrait remplacer. Sans table (hors copie), aucun fichier n'est permis.
  // eslint-disable-next-line no-undef
  const tableBrute = typeof __webaiosFichiers !== "undefined" && estListe(__webaiosFichiers) ? __webaiosFichiers : [];
  // Sans prototype, et lue seulement pour un entier dans ses bornes : un indice hors de la table ne lit jamais
  // `Object.prototype` ni `Array.prototype` (que l'extension peut remplir).
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
  /** L'indice d'un fichier de la table, de ce genre ; lève « fichier refusé : … » sinon. */
  const indiceDe = (genre, p) => {
    const n = typeof p === "string" ? indices[`${genre}:${p}`] : undefined;
    if (typeof n !== "number") throw new Erreur(`fichier refusé : ${typeof p === "string" ? p : typeof p}`);
    return n;
  };
  /** Les chemins d'une liste (copiée), vérifiés contre la table. */
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
  /** Vrai si l'onglet `id` est une vue d'onglet (jamais une lecture invisible) d'un site accordé ; sinon le refus. */
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
  /** L'onglet visé : celui donné, sinon l'onglet actif de la fenêtre courante (comme Chrome). */
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
  /** Les fichiers de la garde, puis `liste` (copie dense). */
  const gardesPuis = (liste) => {
    const r = [];
    for (let i = 0; i < GARDES_PAGE.length; i++) r[r.length] = GARDES_PAGE[i];
    for (let i = 0; i < liste.length; i++) r[r.length] = liste[i];
    return r;
  };
  const mondeIsole = (d) => {
    if (d.world !== undefined && d.world !== "ISOLATED") throw new Erreur(`world ${d.world}`);
  };
  /** Les détails copiés de executeScript / insertCSS : une cible avec un onglet, jamais documentIds. */
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
  /** Les ids des documents rendus par executeScript : tous, ou null (un seul manque suffit). */
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
  /** Les repères (CSS puis JS) d'un script enregistré, après les gardes. */
  const reperesDe = (css, js) => {
    const r = [];
    for (let i = 0; i < css.length; i++) r[r.length] = `${REPERES}${indiceDe("css", css[i])}.js`;
    for (let i = 0; i < js.length; i++) r[r.length] = `${REPERES}${indiceDe("js", js[i])}.js`;
    return gardesPuis(r);
  };
  /** Ce que l'agent avait enregistré (`js`, `css`) d'après la liste réelle (gardes et repères), lue en propre. */
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
  // Saisis avant d'être remplacés : le fond s'en sert pour injecter les fichiers des scripts de contenu.
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
            // La garde d'abord, puis la fonction dans les documents qui l'ont reçue (une navigation entre les deux
            // ne la fait pas tourner ailleurs) ; un document sans id : refus.
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
    /** Un script enregistré : jamais dans le monde de la page ; ses fichiers, vérifiés, deviennent gardes + repères. */
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
          // Un seul de `js` / `css` donné : l'autre est repris de l'enregistrement actuel (il est fait de repères).
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
      // Rend les fichiers de l'agent (et non les gardes et les repères) : l'aller-retour vers updateContentScripts passe.
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
    // MV2 (absentes en MV3) : l'onglet est vérifié ; executeScript passe d'abord les gardes de page dans les mêmes
    // cadres, et n'accepte qu'un fichier de la table.
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

  // --- Contexte des scripts de contenu (garde de page)
  const runtime = c.runtime;
  const onMessage = runtime && runtime.onMessage;
  if (onMessage && typeof onMessage.addListener === "function") {
    const estContexte = (m) => {
      if (m === null || typeof m !== "object") return false;
      const d = descripteur(m, "webaios");
      return !!d && descripteur(d, "value") !== undefined && d.value === "contexte";
    };
    // Le premier écouteur : posé avant tout script de l'extension, dans le service worker seulement. Dans une page, le
    // message est seulement caché aux écouteurs de l'extension (ci-dessous), sans réponse.
    if (estFond) appliquer(onMessage.addListener, onMessage, [
      (m, expediteur, repondre) => {
        if (!estContexte(m)) return undefined;
        const reponse = (v) => {
          try {
            repondre({ onglet: v === true });
          } catch {
            // Le script de contenu est parti.
          }
        };
        const refuser = () => {
          reponse(false);
          return false;
        };
        const exp = expediteur !== null && typeof expediteur === "object" ? expediteur : creer(null);
        const onglet = lirePropre(exp, "tab");
        const id = onglet !== null && typeof onglet === "object" ? lirePropre(onglet, "id") : TROU;
        // Les repères demandés : des indices de la table, CSS et JS séparés dans leur ordre.
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
        // Le document exact qui a demandé (sinon son cadre) : une navigation entre-temps n'y reçoit rien sans garde.
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
            const scripts = () => {
              if (js.length === 0 || !executerNatif) return ok(true);
              const d = creer(null);
              d.target = cible;
              d.files = gardesPuis(js);
              d.injectImmediately = true;
              try {
                ensuite(appliquer(executerNatif, scripting, [d]), () => ok(true), ko);
              } catch (e) {
                ko(e);
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
    // Les écouteurs de l'extension, enveloppés : ce message ne leur parvient pas. Les méthodes d'un événement sont sur son
    // prototype : chaque porteur de la chaîne est remplacé (seul `onMessage` est filtré, les autres événements passent).
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
    // Sur l'événement lui-même aussi : la méthode trouvée par la chaîne, enveloppée.
    for (let j = 0; j < NOMS_EVENEMENT.length; j++) {
      const nom = NOMS_EVENEMENT[j];
      if (descripteur(onMessage, nom)) continue;
      const natif = onMessage[nom];
      if (typeof natif === "function") figer(onMessage, nom, natif);
    }
    figer(runtime, "onMessage", onMessage);
  }
})();
