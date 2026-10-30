// WebAiOs : garde du service worker et des pages des extensions de l'agent (DNR, scripting, tabs, contexte).
// Chargé avant le script d'origine par webaios-fond.js et en premier script de chaque page HTML (script classique ou
// module : aucune déclaration au niveau du fichier). Tâche 12 du plan 12 (la tâche 13 y ajoute la garde des cadres).
//
// - Règles DNR dynamiques et de session : `redirect`, `modifyHeaders`, `regexSubstitution`, `transform` refusés.
// - `tabs.create`, `tabs.update`, `windows.create` : l'adresse est d'abord soumise au processus principal
//   (`globalThis.__webaios.urlPermise`, posé par le preload des correctifs), qui vérifie de nouveau à l'ouverture.
// - `scripting.executeScript` / `insertCSS`, `tabs.executeScript` / `insertCSS` : l'onglet visé doit être un site des
//   hôtes accordés (`__webaios.hotePermis`) ; ces appels natifs n'ont pas d'autre point de contrôle.
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

  const figer = (objet, nom, valeur) => {
    try {
      definir(objet, nom, { value: valeur, writable: false, configurable: false, enumerable: true });
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
      if (runtime) definir(runtime, "lastError", { value: { message }, configurable: true, enumerable: true, writable: true });
      rappel();
    } finally {
      if (runtime) {
        if (avant) definir(runtime, "lastError", avant);
        else delete runtime.lastError;
      }
    }
    return undefined;
  };

  /**
   * Copie profonde lue une seule fois : objets (sans prototype, rien n'y est hérité) et listes recopiés, chaque propriété
   * lue une fois, accesseurs compris ; fonctions et valeurs simples gardées (`scripting.executeScript({ func })`). Un
   * cycle ou une profondeur > 32 : refus.
   */
  const copier = (v, profondeur, chemin) => {
    if (v === null || typeof v !== "object") return v;
    if (profondeur > 32) throw new Erreur("arguments trop imbriqués");
    for (let i = 0; i < chemin.length; i++) if (chemin[i] === v) throw new Erreur("arguments en boucle");
    chemin[chemin.length] = v;
    const liste = estListe(v);
    const copie = liste ? [] : creer(null);
    const k = cles(v);
    for (let i = 0; i < k.length; i++) {
      definir(copie, k[i], { value: copier(v[k[i]], profondeur + 1, chemin), writable: true, enumerable: true, configurable: true });
    }
    chemin.length = chemin.length - 1;
    return copie;
  };

  /**
   * Appelle `f` si `verifier(args)` rend vrai (ou une promesse de vrai), sinon refuse avec `message(args)` ; promesse ou
   * rappel, comme l'appel d'origine. Les arguments sont copiés une seule fois : la copie est vérifiée puis passée à l'API.
   */
  const garder = (f, cible, verifier, message) =>
    function (...tous) {
      // Le rappel éventuel : le dernier argument, s'il est une fonction.
      let n = tous.length;
      const rappel = n > 0 && typeof tous[n - 1] === "function" ? tous[n - 1] : undefined;
      if (rappel) n--;
      let args;
      try {
        args = copier(tous, 0, []);
        args.length = n;
      } catch (e) {
        return refuser(`Arguments refusés par WebAiOs (${e && e.message})`, rappel);
      }
      const appeler = () => {
        if (rappel) args[args.length] = rappel;
        return appliquer(f, cible, args);
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
              echec(message(args));
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
  const requete = tabs && typeof tabs.query === "function" ? tabs.query : null;
  /** L'onglet visé et permis : celui donné, sinon l'onglet actif de la fenêtre courante (comme Chrome). */
  const ongletPermis = (id) =>
    new P((ok) => {
      if (typeof id === "number") return ensuite(hotePermis(id), ok, () => ok(false));
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
          ensuite(hotePermis(actif.id), ok, () => ok(false));
        },
        () => ok(false),
      );
    });
  const NOMS_SCRIPTS = ["executeScript", "insertCSS"];
  const scripting = c.scripting;
  if (scripting) {
    for (let i = 0; i < NOMS_SCRIPTS.length; i++) {
      const f = scripting[NOMS_SCRIPTS[i]];
      if (typeof f !== "function") continue;
      figer(
        scripting,
        NOMS_SCRIPTS[i],
        garder(f, scripting, (args) => !!(args[0] && args[0].target) && ongletPermis(args[0].target.tabId), () => SITE_REFUSE),
      );
    }
    figer(c, "scripting", scripting);
  }
  if (tabs) {
    for (let i = 0; i < NOMS_SCRIPTS.length; i++) {
      const f = tabs[NOMS_SCRIPTS[i]];
      if (typeof f !== "function") continue;
      figer(tabs, NOMS_SCRIPTS[i], garder(f, tabs, (args) => ongletPermis(typeof args[0] === "number" ? args[0] : undefined), () => SITE_REFUSE));
    }
    figer(c, "tabs", tabs);
  }
})();
