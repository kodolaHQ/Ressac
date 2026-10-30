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
(() => {
  const g = globalThis;
  for (const nom of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
    try {
      delete g[nom];
    } catch {
      // Non configurable : la politique WebRTC de la vue coupe l'UDP direct.
    }
  }
  const c = g.chrome;
  const w = g.__webaios;
  if (!c) return;

  const figer = (objet, nom, valeur) => {
    try {
      Object.defineProperty(objet, nom, { value: valeur, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      console.error(`[webaios] garde non posé sur ${nom} :`, e);
    }
  };

  /** Rejette (promesse) ou passe l'erreur au rappel, `chrome.runtime.lastError` posé pendant l'appel, comme Chrome. */
  const refuser = (message, rappel) => {
    const erreur = new Error(message);
    if (typeof rappel !== "function") return Promise.reject(erreur);
    const runtime = c.runtime;
    const avant = runtime && Object.getOwnPropertyDescriptor(runtime, "lastError");
    try {
      if (runtime) Object.defineProperty(runtime, "lastError", { value: { message }, configurable: true, enumerable: true, writable: true });
      rappel();
    } finally {
      if (runtime) {
        if (avant) Object.defineProperty(runtime, "lastError", avant);
        else delete runtime.lastError;
      }
    }
    return undefined;
  };

  /** Sépare le rappel éventuel (dernier argument fonction) des arguments. */
  const separer = (args) => (typeof args[args.length - 1] === "function" ? [args.slice(0, -1), args[args.length - 1]] : [args, undefined]);

  /**
   * Copie profonde lue une seule fois : objets et listes recopiés (chaque propriété lue une fois, accesseurs compris),
   * fonctions et valeurs simples gardées (`scripting.executeScript({ func })`). Un cycle ou une profondeur > 32 : refus.
   */
  const copier = (v, profondeur = 0, vus = new Set()) => {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
    if (typeof v === "function") return v;
    if (profondeur > 32 || vus.has(v)) throw new Error("arguments trop imbriqués");
    vus.add(v);
    const copie = Array.isArray(v) ? [] : {};
    for (const cle of Object.keys(v)) copie[cle] = copier(v[cle], profondeur + 1, vus);
    vus.delete(v);
    return copie;
  };

  /**
   * Appelle `f` si `verifier()` rend vrai, sinon refuse avec `message` ; promesse ou rappel, comme l'appel d'origine.
   * Les arguments sont copiés une seule fois (`copier`) : la copie est vérifiée puis passée à l'API, et un accesseur qui
   * changerait de réponse entre les deux lectures n'a plus de prise.
   */
  const garder = (f, cible, verifier, message) =>
    function (...tous) {
      const [originaux, rappel] = separer(tous);
      let args;
      try {
        args = copier(originaux);
      } catch (e) {
        return refuser(`Arguments refusés par WebAiOs (${e && e.message ? e.message : e})`, rappel);
      }
      const suite = Promise.resolve()
        .then(() => verifier(args))
        .then((ok) => (ok ? true : message(args)));
      if (typeof rappel === "function") {
        suite.then(
          (r) => (r === true ? f.apply(cible, [...args, rappel]) : refuser(r, rappel)),
          (e) => refuser(e && e.message ? e.message : String(e), rappel),
        );
        return undefined;
      }
      return suite.then((r) => (r === true ? f.apply(cible, args) : refuser(r)));
    };

  const URL_REFUSEE = "URL refusée par WebAiOs";
  const SITE_REFUSE = "Site refusé par WebAiOs";
  const urlPermise = async (url) => !!w && typeof w.urlPermise === "function" && (await w.urlPermise(String(url))) === true;
  const hotePermis = async (onglet) => !!w && typeof w.hotePermis === "function" && (await w.hotePermis(onglet)) === true;

  // --- Règles DNR
  const dnr = c.declarativeNetRequest;
  if (dnr) {
    const actionRefusee = (options) => {
      const regles = options && Array.isArray(options.addRules) ? options.addRules : [];
      for (const r of regles) {
        const action = r && r.action;
        const type = action && action.type;
        if (type === "redirect" || type === "modifyHeaders") return type;
        const redirection = action && action.redirect;
        if (redirection && redirection.regexSubstitution !== undefined) return "regexSubstitution";
        if (redirection && redirection.transform !== undefined) return "transform";
      }
      return null;
    };
    for (const nom of ["updateDynamicRules", "updateSessionRules"]) {
      const f = dnr[nom];
      if (typeof f !== "function") continue;
      figer(
        dnr,
        nom,
        garder(
          f,
          dnr,
          ([options]) => actionRefusee(options) === null,
          ([options]) => `Règle DNR refusée par WebAiOs (${actionRefusee(options)})`,
        ),
      );
    }
    figer(c, "declarativeNetRequest", dnr);
  }

  // --- Adresses ouvertes
  const tabs = c.tabs;
  if (tabs) {
    if (typeof tabs.create === "function") {
      figer(tabs, "create", garder(tabs.create, tabs, ([d]) => !(d && d.url) || urlPermise(d.url), () => URL_REFUSEE));
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
        async ([d]) => {
          const urls = d && d.url ? (Array.isArray(d.url) ? d.url : [d.url]) : [];
          for (const u of urls) if (!(await urlPermise(u))) return false;
          return true;
        },
        () => URL_REFUSEE,
      ),
    );
    figer(c, "windows", windows);
  }

  // --- Scripts et styles posés dans un onglet
  /** L'onglet visé : celui donné, sinon l'onglet actif de la fenêtre courante (comme Chrome). */
  const ongletVise = async (id) => {
    if (typeof id === "number") return id;
    if (!tabs || typeof tabs.query !== "function") return null;
    const [actif] = (await tabs.query({ active: true, currentWindow: true })) || [];
    return actif && typeof actif.id === "number" ? actif.id : null;
  };
  const ongletPermis = async (id) => {
    const onglet = await ongletVise(id);
    return onglet !== null && hotePermis(onglet);
  };
  const scripting = c.scripting;
  if (scripting) {
    for (const nom of ["executeScript", "insertCSS"]) {
      const f = scripting[nom];
      if (typeof f !== "function") continue;
      figer(
        scripting,
        nom,
        garder(f, scripting, ([d]) => !!(d && d.target) && ongletPermis(d.target.tabId), () => SITE_REFUSE),
      );
    }
    figer(c, "scripting", scripting);
  }
  if (tabs) {
    for (const nom of ["executeScript", "insertCSS"]) {
      const f = tabs[nom];
      if (typeof f !== "function") continue;
      figer(tabs, nom, garder(f, tabs, (args) => ongletPermis(typeof args[0] === "number" ? args[0] : undefined), () => SITE_REFUSE));
    }
    figer(c, "tabs", tabs);
  }
})();
