// Page actor: the parent asks, the child reads the page (Xray view: the page cannot fake what is read).
export class WebAiOsPageParent extends JSWindowActorParent {}

/** Electron reads the same in an isolated world. */
const TEXT_MAX = 100_000;

export class WebAiOsPageChild extends JSWindowActorChild {
  receiveMessage(m: { name: string }) {
    if (m.name === "getText")
      return { texte: (this.document.body?.innerText ?? "").slice(0, TEXT_MAX), selection: String(this.contentWindow.getSelection() ?? "") };
    return undefined;
  }
}

// Invisible reading: body comes with task 7.
export class WebAiOsReadingChild extends JSWindowActorChild {}
