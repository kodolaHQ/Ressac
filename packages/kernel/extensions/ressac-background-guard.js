// Ressac: guard of the service worker and the pages of the agent's extensions (DNR, scripting, tabs, context).
// Loaded before the original script by ressac-background.js and as the first script of each HTML page (classic script or
// module: no top-level declaration, except the `__ressacFiles` table that the copy writes at the top). Task 12 of plan 12 (task 13 adds the frame guard to it).
//
// - Dynamic and session DNR rules: `redirect`, `modifyHeaders`, `regexSubstitution`, `transform` refused.
// - `tabs.create`, `tabs.update`, `windows.create`: the address is first submitted to the main process
//   (`globalThis.__ressac.urlAllowed`, set by the fixes' preload), which checks again on opening.
// - `scripting.executeScript` / `insertCSS`, `tabs.executeScript` / `insertCSS`: the target tab must be a tab
//   view (`__ressac.isTab`: never an invisible read) and a site of the granted hosts (`__ressac.hostAllowed`);
//   these native calls have no other checkpoint. `target.documentIds` is refused (the guard would not know which
//   tab is targeted), `world: "MAIN"` too (out of reach of the page guard). The named files must be, byte
//   for byte, agent files listed by the copy (`__ressacFiles`, written at the top of this file): no
//   `..`, no absolute path, no Ressac file. `executeScript` (and `tabs.executeScript`) first injects
//   `ressac-page-fixes.js`, `ressac-page-guard.js` and `ressac-scope.js`; with `func`, these files first,
//   then the function in the documents that received them (`documentIds` returned by the first call; a missing id:
//   refusal, no fallback).
// - `scripting.registerContentScripts` / `updateContentScripts`: like the copied manifest's entries, they only register
//   the guards then markers (`ressac-files/<n>.js`, CSS first); `getRegisteredContentScripts` returns the
//   agent's files, and an update of only one of `js` / `css` takes the other from the current registration.
// - `runtime.onMessage`: in the service worker only (an open page of the extension would inject a second
//   time), answers `{ ressac: "context", files }` (the page guard) with `{ tab }`; if it is a tab, first injects, through the captured native functions, the CSS then the JS (guards first) of these markers into the
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
  const apply_ = Reflect.apply;
  const P = Promise;
  const then_ = Promise.prototype.then;
  const isList = Array.isArray;
  const keysOf = Object.keys;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const create_ = Object.create;
  const Err = Error;
  const logError = console.error;

  const RTC_NAMES = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  for (let i = 0; i < RTC_NAMES.length; i++) {
    try {
      delete g[RTC_NAMES[i]];
    } catch {
      // Non-configurable: the view's WebRTC policy cuts direct UDP.
    }
  }
  const c = g.chrome;
  const w = g.__ressac;
  if (!c) return;
  // Captured now: the extension can no longer replace them afterwards for the guard.
  const nativeUrlAllowed = w && typeof w.urlAllowed === "function" ? w.urlAllowed : null;
  const nativeHostAllowed = w && typeof w.hostAllowed === "function" ? w.hostAllowed : null;
  const nativeIsTab = w && typeof w.isTab === "function" ? w.isTab : null;
  const WM = WeakMap;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const protoOf = Object.getPrototypeOf;
  const ObjectProto = Object.prototype;
  const isInt = Number.isInteger;
  // Only the service worker answers the page guard and injects: an open page of the extension (popup, options)
  // would also receive the message, and inject a second time. Captured before any extension script.
  const SWGS = g.ServiceWorkerGlobalScope;
  const isBackground = typeof SWGS === "function" ? g instanceof SWGS : typeof g.document === "undefined" || (!!g.location && g.location.pathname === "/_generated_background_page.html");

  const freeze = (obj, name, value_) => {
    try {
      define(obj, name, { __proto__: null, value: value_, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      apply_(logError, console, [`[ressac] garde non posé sur ${name} :`, e]);
    }
  };

  /** Original `then` on a promise (or a plain value: `ok` right away). */
  const thenOf = (v, ok, ko) => {
    if (v !== null && (typeof v === "object" || typeof v === "function")) {
      try {
        apply_(then_, v, [ok, ko]);
        return;
      } catch {
        // Not an original promise: treated as a value.
      }
    }
    ok(v);
  };

  /** Rejects (promise) or passes the error to the callback, `chrome.runtime.lastError` set during the call, like Chrome. */
  const refuse = (message, callback) => {
    if (typeof callback !== "function") return new P((_ok, ko) => ko(new Err(message)));
    const runtime = c.runtime;
    const before = runtime && descriptor(runtime, "lastError");
    try {
      if (runtime) define(runtime, "lastError", { __proto__: null, value: { message }, configurable: true, enumerable: true, writable: true });
      callback();
    } finally {
      if (runtime) {
        if (before) define(runtime, "lastError", before);
        else delete runtime.lastError;
      }
    }
    return undefined;
  };

  const MAX_LIST = 5000;
  /** An own property read only once through its descriptor (never through the prototype); absent: `trou`. */
  const HOLE = create_(null);
  const readOwn = (v, k) => {
    const d = descriptor(v, k);
    if (!d) return HOLE;
    // The descriptor's fields read as own: `Object.prototype.value` or `.get` added change nothing here.
    const value_ = descriptor(d, "value");
    if (value_) return value_.value;
    const read = descriptor(d, "get");
    return read && typeof read.value === "function" ? apply_(read.value, v, []) : undefined;
  };
  const setAttr = (copied, k, value_) =>
    define(copied, k, { __proto__: null, value: value_, writable: true, enumerable: true, configurable: true });
  /**
   * Deep copy read only once: objects copied without a prototype (nothing is inherited); lists copied dense
   * (`length` read once, at most 5000 items, each read through its own descriptor: a list with holes is refused,
   * since the native API would read the hole in `Array.prototype`); functions and plain values kept
   * (`scripting.executeScript({ func })`). A cycle or a depth > 32: refusal.
   */
  const copy = (v, depth, path) => {
    if (v === null || typeof v !== "object") return v;
    if (depth > 32) throw new Err("arguments trop imbriqués");
    for (let i = 0; i < path.length; i++) if (path[i] === v) throw new Err("arguments en boucle");
    path[path.length] = v;
    let copied;
    if (isList(v)) {
      const n = readOwn(v, "length");
      if (typeof n !== "number" || n > MAX_LIST) throw new Err("tableau trop long");
      copied = [];
      for (let i = 0; i < n; i++) {
        const e = readOwn(v, `${i}`);
        if (e === HOLE) throw new Err("tableau à trous");
        setAttr(copied, i, copy(e, depth + 1, path));
      }
    } else {
      copied = create_(null);
      const k = keysOf(v);
      for (let i = 0; i < k.length; i++) {
        const e = readOwn(v, k[i]);
        if (e !== HOLE) setAttr(copied, k[i], copy(e, depth + 1, path));
      }
    }
    path.length = path.length - 1;
    return copied;
  };

  /**
   * Calls `f` if `verifier(args)` returns true (or a promise of true), otherwise refuses with `message(args)`; promise or
   * callback, like the original call. The arguments are copied only once: the copy is checked then passed to the API.
   */
  const guard = (f, target_, check, message, prefix = "Arguments refusés par Ressac", o = {}) =>
    function (...all) {
      // The possible callback: the last argument, if it is a function.
      let n = all.length;
      const callback = n > 0 && typeof all[n - 1] === "function" ? all[n - 1] : undefined;
      if (callback) n--;
      let args;
      try {
        args = copy(all, 0, []);
        args.length = n;
        // Adaptation of the copied arguments (guard files first…); an error is a refusal.
        if (o.prepare) o.prepare(args);
      } catch (e) {
        return refuse(`${prefix} (${e && e.message})`, callback);
      }
      const callIt = () => {
        if (!o.call) {
          if (callback) args[args.length] = callback;
          return apply_(f, target_, args);
        }
        // Composed call (promises): the callback receives its result, or the refusal with lastError.
        const r = o.call(args);
        if (!callback) return r;
        thenOf(r, (v) => callback(v), (e) => refuse(`${e && e.message}`, callback));
        return undefined;
      };
      return new P((ok, ko) => {
        const failure = (e) => {
          const r = refuse(typeof e === "string" ? e : `${e && e.message}`, callback);
          if (callback) ok(undefined);
          else thenOf(r, ok, ko);
        };
        let verdict;
        try {
          verdict = check(args);
        } catch (e) {
          failure(e);
          return;
        }
        thenOf(
          verdict,
          (allowed) => {
            if (allowed !== true) {
              failure(typeof allowed === "string" ? allowed : message(args));
              return;
            }
            let r;
            try {
              r = callIt();
            } catch (e) {
              ko(e);
              return;
            }
            thenOf(r, ok, ko);
          },
          failure,
        );
      });
    };

  const URL_REFUSED = "URL refusée par Ressac";
  const SITE_REFUSED = "Site refusé par Ressac";
  /** A (original) promise of true if the main process allows it; false without preload. */
  const ask = (native, value_) =>
    new P((ok) => {
      if (!native) return ok(false);
      let r;
      try {
        r = apply_(native, w, [value_]);
      } catch {
        return ok(false);
      }
      thenOf(r, (v) => ok(v === true), () => ok(false));
    });
  const urlAllowed_ = (url) => ask(nativeUrlAllowed, `${url}`);
  const hostAllowed_ = (tab_) => ask(nativeHostAllowed, tab_);
  const isTabOf = (tab_) => ask(nativeIsTab, tab_);
  /** All the promises of true, one after the other (without `Promise.all`, which can be replaced). */
  const every = (list) =>
    new P((ok) => {
      let i = 0;
      const nextOne = () => {
        if (i >= list.length) return ok(true);
        thenOf(urlAllowed_(list[i++]), (v) => (v ? nextOne() : ok(false)), () => ok(false));
      };
      nextOne();
    });

  // --- DNR rules
  const dnr = c.declarativeNetRequest;
  if (dnr) {
    const actionRefused = (options) => {
      const rules = options && isList(options.addRules) ? options.addRules : [];
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const action = r && r.action;
        const type = action && action.type;
        if (type === "redirect" || type === "modifyHeaders") return type;
        const redirection = action && action.redirect;
        if (redirection && redirection.regexSubstitution !== undefined) return "regexSubstitution";
        if (redirection && redirection.transform !== undefined) return "transform";
      }
      return null;
    };
    const DNR_NAMES = ["updateDynamicRules", "updateSessionRules"];
    for (let i = 0; i < DNR_NAMES.length; i++) {
      const f = dnr[DNR_NAMES[i]];
      if (typeof f !== "function") continue;
      freeze(
        dnr,
        DNR_NAMES[i],
        guard(
          f,
          dnr,
          (args) => actionRefused(args[0]) === null,
          (args) => `Règle DNR refusée par Ressac (${actionRefused(args[0])})`,
          "Règle DNR refusée par Ressac",
        ),
      );
    }
    freeze(c, "declarativeNetRequest", dnr);
  }

  // --- Opened addresses
  const tabs = c.tabs;
  if (tabs) {
    if (typeof tabs.create === "function") {
      freeze(tabs, "create", guard(tabs.create, tabs, (args) => !(args[0] && args[0].url) || urlAllowed_(args[0].url), () => URL_REFUSED));
    }
    if (typeof tabs.update === "function") {
      const properties = (args) => (typeof args[0] === "object" && args[0] !== null ? args[0] : args[1]);
      freeze(
        tabs,
        "update",
        guard(
          tabs.update,
          tabs,
          (args) => {
            const p = properties(args);
            return !(p && p.url) || urlAllowed_(p.url);
          },
          () => URL_REFUSED,
        ),
      );
    }
  }
  const windows = c.windows;
  if (windows && typeof windows.create === "function") {
    freeze(
      windows,
      "create",
      guard(
        windows.create,
        windows,
        (args) => {
          const d = args[0];
          return every(d && d.url ? (isList(d.url) ? d.url : [d.url]) : []);
        },
        () => URL_REFUSED,
      ),
    );
    freeze(c, "windows", windows);
  }

  // --- Scripts and styles placed in a tab
  const TAB_REFUSED = "Onglet refusé par Ressac";
  const PAGE_GUARDS = ["ressac-page-fixes.js", "ressac-page-guard.js", "ressac-scope.js"];
  const MARKERS = "ressac-files/";
  // The table written by the copy at the top of this file: every .js and .css of the agent, the index is its marker. The
  // paths are compared as they are to this list (key in an object without a prototype): no splitting, no
  // normalization by a method the extension could replace. Without a table (outside the copy), no file is allowed.
  // eslint-disable-next-line no-undef
  const rawTable = typeof __ressacFiles !== "undefined" && isList(__ressacFiles) ? __ressacFiles : [];
  // Without a prototype, and read only for an integer within its bounds: an index outside the table never reads
  // `Object.prototype` or `Array.prototype` (which the extension can fill).
  const table = create_(null);
  let tableSize = 0;
  const entryOf = (n) => (typeof n === "number" && isInt(n) && n >= 0 && n < tableSize ? table[n] : undefined);
  const indexes = create_(null);
  const markers = create_(null);
  for (let i = 0; i < rawTable.length; i++) {
    const e = rawTable[i];
    if (!isList(e) || typeof e[0] !== "string" || (e[1] !== "js" && e[1] !== "css")) continue;
    const n = tableSize++;
    table[n] = { __proto__: null, path: e[0], kind: e[1] };
    indexes[`${e[1]}:${e[0]}`] = n;
    markers[`${MARKERS}${n}.js`] = n;
  }
  const isPageGuard = (p) => p === PAGE_GUARDS[0] || p === PAGE_GUARDS[1] || p === PAGE_GUARDS[2];
  /** The index of a file of the table, of this kind; throws "fichier refusé : …" otherwise. */
  const indexOf_ = (kind, p) => {
    const n = typeof p === "string" ? indexes[`${kind}:${p}`] : undefined;
    if (typeof n !== "number") throw new Err(`fichier refusé : ${typeof p === "string" ? p : typeof p}`);
    return n;
  };
  /** The paths of a list (copied), checked against the table. */
  const allowedFiles = (kind, list) => {
    if (!isList(list)) throw new Err("liste de fichiers attendue");
    const r = [];
    for (let i = 0; i < list.length; i++) {
      indexOf_(kind, list[i]);
      r[r.length] = list[i];
    }
    return r;
  };
  const request = tabs && typeof tabs.query === "function" ? tabs.query : null;
  /**
   * The frames an injection targets, as the main process's isTab reads them (`<tab>:<frame>`, `*` every frame): the
   * main process refuses a frame whose own document is sensitive (masking). null: a malformed list.
   */
  const framesOf = (d) => {
    if (d === null || typeof d !== "object") return ["0"];
    if (d.allFrames === true) return ["*"];
    const f = d.frameIds !== undefined ? d.frameIds : d.frameId !== undefined ? [d.frameId] : null;
    if (f === null) return ["0"];
    if (!isList(f) || f.length === 0 || f.length > MAX_LIST) return null;
    const r = [];
    for (let i = 0; i < f.length; i++) {
      if (typeof f[i] !== "number") return null;
      r[r.length] = `${f[i]}`;
    }
    return r;
  };
  /** True if each targeted frame of tab `id` is a tab view (never an invisible read) of a granted site; otherwise the refusal. */
  const tabVerdict = (id, frames) =>
    new P((ok) => {
      if (frames === null) return ok(TAB_REFUSED);
      let i = 0;
      const nextFrame = () => {
        if (i >= frames.length) return thenOf(hostAllowed_(id), (v) => ok(v ? true : SITE_REFUSED), () => ok(SITE_REFUSED));
        thenOf(isTabOf(`${id}:${frames[i++]}`), (tab_) => (tab_ ? nextFrame() : ok(TAB_REFUSED)), () => ok(TAB_REFUSED));
      };
      nextFrame();
    });
  /** The targeted tab: the one given, otherwise the active tab of the current window (like Chrome). */
  const tabAllowed = (id, frames) =>
    new P((ok) => {
      if (typeof id === "number") return thenOf(tabVerdict(id, frames), ok, () => ok(false));
      if (!request) return ok(false);
      let r;
      try {
        r = apply_(request, tabs, [{ active: true, currentWindow: true }]);
      } catch {
        return ok(false);
      }
      thenOf(
        r,
        (list) => {
          const active = list && list[0];
          if (!active || typeof active.id !== "number") return ok(false);
          thenOf(tabVerdict(active.id, frames), ok, () => ok(false));
        },
        () => ok(false),
      );
    });
  /** The guard's files, then `liste` (dense copy). */
  const guardsThen = (list) => {
    const r = [];
    for (let i = 0; i < PAGE_GUARDS.length; i++) r[r.length] = PAGE_GUARDS[i];
    for (let i = 0; i < list.length; i++) r[r.length] = list[i];
    return r;
  };
  const isolatedWorld = (d) => {
    if (d.world !== undefined && d.world !== "ISOLATED") throw new Err(`world ${d.world}`);
  };
  /** The copied details of executeScript / insertCSS: a target with a tab, never documentIds. */
  const ownTarget = (args) => {
    const d = args[0];
    if (d === null || typeof d !== "object") throw new Err("détails absents");
    const t = d.target;
    if (t === null || typeof t !== "object") throw new Err("cible absente");
    if (t.documentIds !== undefined) throw new Err("documentIds");
    isolatedWorld(d);
    return d;
  };
  const checkTarget = (args) => (typeof args[0].target.tabId === "number" ? tabAllowed(args[0].target.tabId, framesOf(args[0].target)) : SITE_REFUSED);
  /** The ids of the documents returned by executeScript: all of them, or null (a single missing one is enough). */
  const documentsOf = (results) => {
    if (!isList(results)) return null;
    const n = readOwn(results, "length");
    if (typeof n !== "number" || n === 0 || n > MAX_LIST) return null;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const r = readOwn(results, `${i}`);
      const id = r !== null && typeof r === "object" ? readOwn(r, "documentId") : HOLE;
      if (typeof id !== "string") return null;
      ids[ids.length] = id;
    }
    return ids;
  };
  /** The markers (CSS then JS) of a registered script, after the guards. */
  const markersOf = (css, js) => {
    const r = [];
    for (let i = 0; i < css.length; i++) r[r.length] = `${MARKERS}${indexOf_("css", css[i])}.js`;
    for (let i = 0; i < js.length; i++) r[r.length] = `${MARKERS}${indexOf_("js", js[i])}.js`;
    return guardsThen(r);
  };
  /** What the agent had registered (`js`, `css`) according to the real list (guards and markers), read as own. */
  const decoder = (list) => {
    const seen = { __proto__: null, js: [], css: [] };
    if (!isList(list)) return seen;
    const n = readOwn(list, "length");
    for (let i = 0; typeof n === "number" && i < n && i < MAX_LIST; i++) {
      const p = readOwn(list, `${i}`);
      if (typeof p !== "string" || isPageGuard(p)) continue;
      const k = markers[p];
      if (typeof k !== "number") continue;
      const e = entryOf(k);
      if (!e) continue;
      seen[e.kind][seen[e.kind].length] = e.path;
    }
    return seen;
  };
  const scripting = c.scripting;
  // On Firefox (the only one with getBrowserInfo), one executeScript per file: Firefox drops a whole call when one of
  // its files fails to compile, Chromium only that file. Same world either way.
  const onePerFile = !!c.runtime && typeof c.runtime.getBrowserInfo === "function";
  // Captured before being replaced: the background uses them to inject the content scripts' files.
  const nativeExecute = scripting && typeof scripting.executeScript === "function" ? scripting.executeScript : null;
  const nativeCss = scripting && typeof scripting.insertCSS === "function" ? scripting.insertCSS : null;
  if (scripting) {
    if (nativeExecute) {
      const execute = nativeExecute;
      freeze(
        scripting,
        "executeScript",
        guard(execute, scripting, checkTarget, () => SITE_REFUSED, undefined, {
          prepare: (args) => {
            const d = ownTarget(args);
            if (d.files !== undefined) d.files = guardsThen(allowedFiles("js", d.files));
          },
          call: (args) => {
            const d = args[0];
            if (d.func === undefined) return apply_(execute, scripting, [d]);
            // The guard first, then the function in the documents that received it (a navigation between the two
            // does not make it run elsewhere); a document without an id: refusal.
            const first = create_(null);
            first.target = d.target;
            first.files = guardsThen([]);
            if (d.injectImmediately !== undefined) first.injectImmediately = d.injectImmediately;
            return new P((ok, ko) => {
              let r;
              try {
                r = apply_(execute, scripting, [first]);
              } catch (e) {
                return ko(e);
              }
              thenOf(
                r,
                (results) => {
                  const ids = documentsOf(results);
                  if (!ids) return ko(new Err("Arguments refusés par Ressac (documentId absent)"));
                  const t = create_(null);
                  t.tabId = d.target.tabId;
                  t.documentIds = ids;
                  d.target = t;
                  let r2;
                  try {
                    r2 = apply_(execute, scripting, [d]);
                  } catch (e) {
                    return ko(e);
                  }
                  thenOf(r2, ok, ko);
                },
                ko,
              );
            });
          },
        }),
      );
    }
    const CSS_NAMES = ["insertCSS", "removeCSS"];
    for (let i = 0; i < CSS_NAMES.length; i++) {
      const f = scripting[CSS_NAMES[i]];
      if (typeof f !== "function") continue;
      freeze(
        scripting,
        CSS_NAMES[i],
        guard(f, scripting, checkTarget, () => SITE_REFUSED, undefined, {
          prepare: (args) => {
            const d = ownTarget(args);
            if (d.files !== undefined) d.files = allowedFiles("css", d.files);
          },
        }),
      );
    }
    /** A registered script: never in the page's world; its files, checked, become guards + markers. */
    const copiedScripts = (args) => {
      const list = args[0];
      if (!isList(list)) throw new Err("liste de scripts attendue");
      for (let j = 0; j < list.length; j++) {
        const s = list[j];
        if (s === null || typeof s !== "object") throw new Err("script illisible");
        isolatedWorld(s);
        if (s.js !== undefined) allowedFiles("js", s.js);
        if (s.css !== undefined) allowedFiles("css", s.css);
      }
      return list;
    };
    const rewrite = (s, current) => {
      if (s.js === undefined && s.css === undefined) return;
      s.js = markersOf(s.css !== undefined ? s.css : current.css, s.js !== undefined ? s.js : current.js);
      delete s.css;
    };
    const EMPTY = { __proto__: null, js: [], css: [] };
    const register = scripting.registerContentScripts;
    if (typeof register === "function") {
      freeze(
        scripting,
        "registerContentScripts",
        guard(register, scripting, () => true, () => SITE_REFUSED, undefined, {
          prepare: (args) => {
            const list = copiedScripts(args);
            for (let j = 0; j < list.length; j++) rewrite(list[j], EMPTY);
          },
        }),
      );
    }
    const readRegistered = scripting.getRegisteredContentScripts;
    const mettreAJour = scripting.updateContentScripts;
    if (typeof mettreAJour === "function") {
      freeze(
        scripting,
        "updateContentScripts",
        guard(mettreAJour, scripting, () => true, () => SITE_REFUSED, undefined, {
          prepare: copiedScripts,
          // Only one of `js` / `css` given: the other is taken from the current registration (it is made of markers).
          call: (args) => {
            const list = args[0];
            const ids = [];
            for (let j = 0; j < list.length; j++) {
              const s = list[j];
              if ((s.js === undefined) !== (s.css === undefined)) ids[ids.length] = s.id;
            }
            const finish = (currents) => {
              for (let j = 0; j < list.length; j++) rewrite(list[j], currents[`${list[j].id}`] || EMPTY);
              return apply_(mettreAJour, scripting, [list]);
            };
            if (ids.length === 0 || typeof readRegistered !== "function") return finish(create_(null));
            return new P((ok, ko) => {
              thenOf(
                apply_(readRegistered, scripting, [{ ids }]),
                (readCount) => {
                  const currents = create_(null);
                  const n = isList(readCount) ? readOwn(readCount, "length") : 0;
                  for (let i = 0; typeof n === "number" && i < n && i < MAX_LIST; i++) {
                    const x = readOwn(readCount, `${i}`);
                    const id = x !== null && typeof x === "object" ? readOwn(x, "id") : HOLE;
                    if (typeof id === "string") currents[id] = decoder(readOwn(x, "js"));
                  }
                  let r;
                  try {
                    r = finish(currents);
                  } catch (e) {
                    return ko(e);
                  }
                  thenOf(r, ok, ko);
                },
                ko,
              );
            });
          },
        }),
      );
    }
    if (typeof readRegistered === "function") {
      // Returns the agent's files (and not the guards and the markers): the round trip to updateContentScripts works.
      freeze(
        scripting,
        "getRegisteredContentScripts",
        guard(readRegistered, scripting, () => true, () => SITE_REFUSED, undefined, {
          call: (args) =>
            new P((ok, ko) => {
              thenOf(
                apply_(readRegistered, scripting, args.length > 0 && args[0] !== undefined ? [args[0]] : []),
                (readCount) => {
                  const r = [];
                  const n = isList(readCount) ? readOwn(readCount, "length") : 0;
                  for (let i = 0; typeof n === "number" && i < n && i < MAX_LIST; i++) {
                    const x = readOwn(readCount, `${i}`);
                    if (x === null || typeof x !== "object") continue;
                    const y = {};
                    const k = keysOf(x);
                    for (let j = 0; j < k.length; j++) if (k[j] !== "js" && k[j] !== "css") setAttr(y, k[j], readOwn(x, k[j]));
                    const seen = decoder(readOwn(x, "js"));
                    if (seen.js.length > 0) setAttr(y, "js", seen.js);
                    if (seen.css.length > 0) setAttr(y, "css", seen.css);
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
    freeze(c, "scripting", scripting);
  }
  if (tabs) {
    // MV2 (absent in MV3): the tab is checked; executeScript first passes the page guards into the same
    // frames, and only accepts a file of the table.
    const detailsOf = (args) => (typeof args[0] === "number" || args[0] === undefined || args[0] === null ? args[1] : args[0]);
    const checkTab = (args) => tabAllowed(typeof args[0] === "number" ? args[0] : undefined, framesOf(detailsOf(args)));
    const executeInTab = tabs.executeScript;
    if (typeof executeInTab === "function") {
      freeze(
        tabs,
        "executeScript",
        guard(executeInTab, tabs, checkTab, () => SITE_REFUSED, undefined, {
          prepare: (args) => {
            const d = detailsOf(args);
            if (d === null || typeof d !== "object") throw new Err("détails absents");
            if (d.file !== undefined) indexOf_("js", d.file);
          },
          call: (args) =>
            new P((ok, ko) => {
              const d = detailsOf(args);
              let i = 0;
              const next = () => {
                if (i >= PAGE_GUARDS.length) {
                  let r;
                  try {
                    r = apply_(executeInTab, tabs, args);
                  } catch (e) {
                    return ko(e);
                  }
                  return thenOf(r, ok, ko);
                }
                const g = create_(null);
                g.file = PAGE_GUARDS[i++];
                const k = keysOf(d);
                for (let j = 0; j < k.length; j++) if (k[j] !== "file" && k[j] !== "code") g[k[j]] = d[k[j]];
                let r;
                try {
                  r = apply_(executeInTab, tabs, typeof args[0] === "number" ? [args[0], g] : [g]);
                } catch (e) {
                  return ko(e);
                }
                thenOf(r, next, ko);
              };
              next();
            }),
        }),
      );
    }
    const tabCss = tabs.insertCSS;
    if (typeof tabCss === "function") freeze(tabs, "insertCSS", guard(tabCss, tabs, checkTab, () => SITE_REFUSED));
    freeze(c, "tabs", tabs);
  }

  // --- Content scripts context (page guard)
  const runtime = c.runtime;
  const onMessage = runtime && runtime.onMessage;
  if (onMessage && typeof onMessage.addListener === "function") {
    const isContext = (m) => {
      if (m === null || typeof m !== "object") return false;
      const d = descriptor(m, "ressac");
      return !!d && descriptor(d, "value") !== undefined && d.value === "context";
    };
    // The first listener: set before any extension script, in the service worker only. In a page, the
    // message is only hidden from the extension's listeners (below), with no answer.
    if (isBackground) apply_(onMessage.addListener, onMessage, [
      (m, sender, answer) => {
        if (!isContext(m)) return undefined;
        const response = (v) => {
          try {
            answer({ tab: v === true });
          } catch {
            // The content script is gone.
          }
        };
        const refuse = () => {
          response(false);
          return false;
        };
        const exp = sender !== null && typeof sender === "object" ? sender : create_(null);
        const tab_ = readOwn(exp, "tab");
        const id = tab_ !== null && typeof tab_ === "object" ? readOwn(tab_, "id") : HOLE;
        // The requested markers: indexes of the table, CSS and JS separate in their order.
        const css = [];
        const js = [];
        const requests = readOwn(m, "files");
        if (requests !== HOLE && requests !== undefined) {
          let list;
          try {
            list = copy(requests, 0, []);
          } catch {
            list = null;
          }
          if (!isList(list)) return refuse();
          for (let i = 0; i < list.length; i++) {
            const n = list[i];
            const e = entryOf(n);
            if (!e) return refuse();
            const l = e.kind === "css" ? css : js;
            l[l.length] = e.path;
          }
        }
        if (typeof id !== "number") return refuse();
        // The exact document that asked (otherwise its frame): a navigation in the meantime receives nothing there without a guard.
        const documentId = readOwn(exp, "documentId");
        const frame = readOwn(exp, "frameId");
        const target_ = create_(null);
        target_.tabId = id;
        if (typeof documentId === "string") target_.documentIds = [documentId];
        else if (typeof frame === "number") target_.frameIds = [frame];
        else if (css.length + js.length > 0) return refuse();
        const inject = () =>
          new P((ok) => {
            const ko = (e) => {
              apply_(logError, console, ["[ressac] fichiers des scripts de contenu non injectés :", e]);
              ok(true);
            };
            let i = 0;
            const scripts = () => {
              if (i >= js.length || !nativeExecute) return ok(true);
              const d = create_(null);
              d.target = target_;
              if (onePerFile) d.files = guardsThen([js[i++]]);
              else {
                d.files = guardsThen(js);
                i = js.length;
              }
              d.injectImmediately = true;
              const next = (e) => {
                apply_(logError, console, ["[ressac] fichiers des scripts de contenu non injectés :", e]);
                scripts();
              };
              try {
                thenOf(apply_(nativeExecute, scripting, [d]), () => scripts(), next);
              } catch (e) {
                next(e);
              }
            };
            if (css.length === 0 || !nativeCss) return scripts();
            const d = create_(null);
            d.target = target_;
            d.files = css;
            try {
              thenOf(apply_(nativeCss, scripting, [d]), scripts, ko);
            } catch (e) {
              ko(e);
            }
          });
        // The sender's own frame (`*` if unknown): the main process refuses it when its document is sensitive (masking).
        thenOf(
          isTabOf(`${id}:${typeof frame === "number" ? frame : "*"}`),
          (v) => {
            if (v !== true) return response(false);
            thenOf(inject(), () => response(true), () => response(true));
          },
          () => response(false),
        );
        return true;
      },
    ]);
    // The extension's listeners, wrapped: this message does not reach them. An event's methods are on its
    // prototype: each holder of the chain is replaced (only `onMessage` is filtered, the other events pass).
    const wrappers = new WM();
    const wrap = (f) => {
      let e = apply_(wmGet, wrappers, [f]);
      if (!e) {
        e = function (m, sender, answer) {
          if (isContext(m)) return undefined;
          return apply_(f, this, [m, sender, answer]);
        };
        apply_(wmSet, wrappers, [f, e]);
      }
      return e;
    };
    const EVENT_NAMES = ["addListener", "removeListener", "hasListener"];
    const carriers = [];
    for (let o = onMessage, n = 0; o !== null && o !== ObjectProto && n < 16; o = protoOf(o), n++) carriers[carriers.length] = o;
    for (let i = carriers.length - 1; i >= 0; i--) {
      const o = carriers[i];
      for (let j = 0; j < EVENT_NAMES.length; j++) {
        const name = EVENT_NAMES[j];
        const d = descriptor(o, name);
        const native = d && descriptor(d, "value") ? d.value : undefined;
        if (typeof native !== "function") continue;
        freeze(o, name, function (f) {
          if (this !== onMessage || typeof f !== "function") return apply_(native, this, [f]);
          return apply_(native, this, [name === "addListener" ? wrap(f) : apply_(wmGet, wrappers, [f]) || f]);
        });
      }
    }
    // On the event itself too: the method found through the chain, wrapped.
    for (let j = 0; j < EVENT_NAMES.length; j++) {
      const name = EVENT_NAMES[j];
      if (descriptor(onMessage, name)) continue;
      const native = onMessage[name];
      if (typeof native === "function") freeze(onMessage, name, native);
    }
    freeze(runtime, "onMessage", onMessage);
  }
})();
