// The UI's network (spec 2026-11-08-webaios-firefox-reseau-interfaces-design.md, Electron's reseau-interface.ts): nothing
// the UI shows (sidebar, agent panel, overlays, badges, site bar, widgets, components, site homes, their frames) loads
// from http(s)/ws(s), whatever the host. A content policy refuses the opaque documents' loads before their channel
// exists; an http-on-opening-request observer cancels the rest (the only layer of the system documents, which Firefox
// exempts from content policies); a PeerConnection:request observer denies their WebRTC. Measured: spikes S1–S3.

export const UI_PREFIXES: readonly string[] = ["chrome://browser/content/webaios/", "resource://webaios-widget-", "resource://webaios-composant-", "resource://webaios-site-"];
const BLOCKED = /^(https?|wss?):/i;

/** http, https, ws, wss whatever the host; `view-source:` prefixes are stripped first. Every other scheme passes. */
export function isBlockedAddress(spec: string): boolean {
  let s = String(spec);
  while (/^view-source:/i.test(s)) s = s.slice("view-source:".length);
  return BLOCKED.test(s);
}

/** From doc up through in-process ancestors (defaultView.browsingContext → embedderElement.ownerDocument): an absent or content context ends it (false) before the address is read; true on the first UI address, or past the walk's bound (fails closed). */
export function isUiDocument(doc: Document | null | undefined): boolean {
  try {
    let d: any = doc;
    for (let i = 0; d && i < 32; i++) {
      const bc = d.defaultView?.browsingContext;
      if (!bc || bc.isContent) return false;
      const uri = String(d.documentURI);
      if (UI_PREFIXES.some((p) => uri.startsWith(p))) return true;
      d = bc.embedderElement?.ownerDocument;
    }
    // Past the bound with ancestors left: counted as the UI's, as the press walk does (no real chrome chain is that deep).
    return d != null;
  } catch {
    // A dead object: not the UI's.
  }
  return false;
}

/** A frame cut by cutFrameNetwork: its docShell's appType is APP_TYPE_MAIL. */
export function isUiFrame(el: Element | null | undefined): boolean {
  try {
    return (el as any)?.frameLoader?.docShell?.appType === Ci.nsIDocShell.APP_TYPE_MAIL;
  } catch {
    return false;
  }
}

const hasUiAddress = (p: any): boolean => UI_PREFIXES.some((x) => String((p.precursorPrincipal ?? p).spec).startsWith(x));

/**
 * loadingDocument is the UI's; or, without one, a chrome target (else associated) context whose embedderElement isUiFrame
 * or sits in a UI document; or, without any context, a principal at a UI address (system too for a WebTransport). Never reads loadingNode.
 */
export function isUiLoad(li: { loadingDocument: Document | null; browsingContext: any; targetBrowsingContext?: any; associatedBrowsingContext?: any; loadingPrincipal?: any; externalContentPolicyType?: number }): boolean {
  try {
    if (li.loadingDocument) return isUiDocument(li.loadingDocument);
    // A frame's navigation (DocumentLoadListener, LoadInfo::CreateForFrame): browsingContext is the parent's, the target is
    // the frame. A dedicated worker's fetch or WebSocket: at most the associated context (its document's).
    const bc = li.targetBrowsingContext ?? li.browsingContext ?? li.associatedBrowsingContext;
    // No context: WebTransport (built from a principal, context set after AsyncOpen: WebTransportSessionProxy.cpp), a
    // parent-process worker's fetch (measured). System principals pass but WebTransport's: action images, add-on installs.
    if (!bc) {
      const p = li.loadingPrincipal;
      return !!p && (hasUiAddress(p) || (p.isSystemPrincipal && li.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_WEB_TRANSPORT));
    }
    if (bc.isContent) return false;
    const e = bc.embedderElement;
    return !!e && (isUiFrame(e) || isUiDocument(e.ownerDocument));
  } catch {
    return false;
  }
}

const refused = (type: unknown, spec: string) => console.warn("[ui-network] refused", type, String(spec).slice(0, 80));

const POLICY_CONTRACT = "@webaios/ui-network-policy;1";
export const uiPolicy = {
  classID: Components.ID("{8e2c4a71-5f3d-4b9e-a6c0-1d7f2b9e3c58}"),
  QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
  createInstance: (iid: unknown) => (uiPolicy.QueryInterface as (iid: unknown) => unknown)(iid),
  shouldLoad(location: { spec: string }, li: any): number {
    if (!isBlockedAddress(location.spec) || !isUiLoad(li)) return Ci.nsIContentPolicy.ACCEPT;
    refused(li.externalContentPolicyType, location.spec);
    return Ci.nsIContentPolicy.REJECT_REQUEST;
  },
  shouldProcess: () => Ci.nsIContentPolicy.ACCEPT,
};

const openingObserver = {
  observe(subject: any): void {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (!isUiLoad(channel.loadInfo) || !isBlockedAddress(channel.URI.spec)) return;
    channel.cancel(Cr.NS_BINDING_ABORTED);
    refused(channel.loadInfo.externalContentPolicyType, channel.URI.spec);
  },
};

const webrtcObserver = {
  observe(subject: any): void {
    const doc = Services.wm.getOuterWindowWithId(subject.windowID)?.document;
    if (!isUiDocument(doc)) return;
    Services.obs.notifyObservers(null, "PeerConnection:response:deny", subject.callID);
    console.warn("[ui-network] refused webrtc", String(doc.documentURI).slice(0, 80));
  },
};

export interface UiNetworkState {
  policy: boolean;
  observer: boolean;
  webrtc: boolean;
}

/** Registers the policy, then the observer, then the WebRTC refusal, each in its own try (console.error on failure). `fail` forces one step to throw (e2e: WEBAIOS_TEST_UI_NETWORK_FAIL). */
export function installUiNetwork(fail?: string | null): UiNetworkState {
  const step = (name: keyof UiNetworkState, install: () => void): boolean => {
    try {
      if (fail === name) throw new Error("forced by WEBAIOS_TEST_UI_NETWORK_FAIL");
      install();
      return true;
    } catch (e) {
      console.error(`[ui-network] the ${name} did not install:`, e);
      return false;
    }
  };
  return {
    policy: step("policy", () => {
      Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(uiPolicy.classID, "WebAiOs UI network policy", POLICY_CONTRACT, uiPolicy);
      Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
    }),
    observer: step("observer", () => Services.obs.addObserver(openingObserver, "http-on-opening-request")),
    webrtc: step("webrtc", () => Services.obs.addObserver(webrtcObserver, "PeerConnection:request")),
  };
}
