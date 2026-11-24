import { expect, test, vi } from "vitest";

vi.stubGlobal("JSWindowActorParent", class {});
vi.stubGlobal("JSWindowActorChild", class {});
const { RessacFillChild } = await import("../../chrome/agent/fill-actor");

const XHTML = "http://www.w3.org/1999/xhtml";
const ORIGIN = "https://bank.test";

/** Just enough DOM for the child: a tree of elements, forms with an action, events recorded. */
class El {
  parentNode: El | Doc | null = null;
  children: El[] = [];
  attrs: Record<string, string> = {};
  namespaceURI = XHTML;
  type = "";
  disabled = false;
  readOnly = false;
  value = "";
  textContent = "";
  hidden = false;
  offscreen = false;
  formAction = "";
  /** A control tied to a form elsewhere (`form=`). */
  owner: Form | null = null;
  labels: { textContent: string }[] = [];
  events: string[] = [];
  constructor(
    public localName: string,
    o: Partial<El> & { attrs?: Record<string, string> } = {},
  ) {
    Object.assign(this, o);
  }
  get ownerDocument(): Doc | null {
    let n: El | Doc | null = this;
    while (n instanceof El) n = n.parentNode;
    return n;
  }
  get isConnected() {
    return this.ownerDocument !== null;
  }
  get previousElementSibling(): El | null {
    const p = this.parentNode;
    return p ? (p.children[p.children.indexOf(this) - 1] ?? null) : null;
  }
  get nextElementSibling(): El | null {
    const p = this.parentNode;
    return p ? (p.children[p.children.indexOf(this) + 1] ?? null) : null;
  }
  get parentElement(): El | null {
    return this.parentNode instanceof El ? this.parentNode : null;
  }
  get form(): Form | null {
    if (this.owner) return this.owner;
    for (let n = this.parentNode; n instanceof El; n = n.parentNode) if (n instanceof Form) return n;
    return null;
  }
  get isContentEditable(): boolean {
    return "contenteditable" in this.attrs || !!this.parentElement?.isContentEditable;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  checkVisibility() {
    return !this.hidden;
  }
  /** In view unless a test moves it (`offscreen`). */
  getBoundingClientRect() {
    return this.offscreen ? { top: 5000, bottom: 5020, left: 0, right: 100 } : { top: 0, bottom: 20, left: 0, right: 100 };
  }
  dispatchEvent(e: { type: string }) {
    this.events.push(e.type);
    return true;
  }
  append(...els: El[]) {
    for (const e of els) {
      e.remove();
      e.parentNode = this;
      this.children.push(e);
    }
    return this;
  }
  remove() {
    const p = this.parentNode;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(e: El) {
    const p = this.parentNode!;
    e.parentNode = p;
    p.children[p.children.indexOf(this)] = e;
    this.parentNode = null;
  }
}
class Form extends El {
  constructor(public actionUrl: string) {
    super("form");
  }
  // The real getter, which a control named « action » cannot shadow on the prototype.
  get action() {
    return this.actionUrl;
  }
}
class Doc {
  children: El[] = [];
  parentNode = null;
  nodePrincipal = { originNoSuffix: ORIGIN };
  querySelectorAll(selector: string): El[] {
    const names = selector.split(",").map((s) => s.trim());
    const out: El[] = [];
    const walk = (n: El) => {
      if (names.includes(n.localName) || (names.includes("[contenteditable]") && "contenteditable" in n.attrs)) out.push(n);
      n.children.forEach(walk);
    };
    this.children.forEach(walk);
    return out;
  }
}

function setup() {
  const doc = new Doc();
  const body = new El("body");
  body.parentNode = doc;
  doc.children.push(body);
  const child = new RessacFillChild() as any;
  Object.assign(child, {
    document: doc,
    windowContext: { innerWindowId: 7, isInBFCache: false },
    contentWindow: { HTMLFormElement: Form, Event: class { constructor(public type: string) {} }, innerWidth: 1000, innerHeight: 800 },
  });
  const fields = () => child.receiveMessage({ name: "fields" }) as { n: number; type: string; autocomplete: string; label: string }[];
  const facts = (handle: number) => child.receiveMessage({ name: "facts", data: { handle } }) as { type: string; autocomplete: string; action: string | null; placement: string; partner: number | null; role: string | null } | null;
  /** The parent's seal from the child's facts (it computes `frames` itself). */
  const seal = (handle: number) => ({ innerWindowId: 7, handle, frames: [ORIGIN], ...facts(handle)! });
  const fill = (s: object, value: string) => child.receiveMessage({ name: "fill", data: { seal: s, value } });
  return { doc, body, child, fields, facts, seal, fill };
}

const input = (type: string, attrs: Record<string, string> = {}) => new El("input", { type, attrs });

test("fields: the fillable fields of the document, each keeping its number for the document's life", () => {
  const { body, fields } = setup();
  const user = input("text", { autocomplete: " Username ", name: "u" });
  const pass = input("password", { "aria-label": "Mot de passe" });
  user.labels = [{ textContent: "  Identifiant\n client " }];
  body.append(user, input("hidden"), input("submit"), input("text", {}), pass);
  (body.children[3] as El).disabled = true;
  const box = new El("textarea", { type: "textarea", attrs: { placeholder: "Message" } });
  const editor = new El("div", { attrs: { contenteditable: "" } });
  editor.append(new El("p"));
  body.append(box, editor, new El("input", { type: "text", namespaceURI: "http://www.w3.org/2000/svg" }), Object.assign(input("text"), { hidden: true }));
  expect(fields()).toEqual([
    { n: 0, type: "text", autocomplete: "username", label: "Identifiant client" },
    { n: 1, type: "password", autocomplete: "", label: "Mot de passe" },
    { n: 2, type: "textarea", autocomplete: "", label: "Message" },
    { n: 3, type: "contenteditable", autocomplete: "", label: "" },
  ]);
  // A field put before the others gets a new number; the others keep theirs (the kernel numbers from its read).
  const injected = input("text", { name: "x" });
  body.children.unshift(injected);
  injected.parentNode = body;
  expect(fields().map((f) => f.n)).toEqual([4, 0, 1, 2, 3]);
});

test("fill: a field still the one sealed is written, then input and change go to the page", () => {
  const { body, fields, seal, fill } = setup();
  const form = new Form(ORIGIN + "/login");
  const code = input("text", { name: "code" });
  const editor = new El("div", { attrs: { contenteditable: "true" } });
  body.append(form.append(code), editor);
  fields();
  expect(fill(seal(0), "v1")).toBe("filled");
  expect(code.value).toBe("v1");
  expect(code.events).toEqual(["input", "change"]);
  expect(fill(seal(1), "v2")).toBe("filled");
  expect(editor.textContent).toBe("v2");
});

test("fill: a seal is good once; anything changed since the seal writes nothing", () => {
  const { body, fields, seal, fill, child } = setup();
  const form = new Form(ORIGIN + "/login");
  const other = new Form(ORIGIN + "/login");
  const field = () => form.children[0] as El;
  body.append(form.append(input("password")), other);
  fields();
  const once = seal(0);
  expect(fill(once, "a")).toBe("filled");
  expect(fill(once, "b")).toBe("changed");
  expect(field().value).toBe("a");

  const cases: [string, (s: any) => void][] = [
    ["another document", () => (child.windowContext = { innerWindowId: 8, isInBFCache: false })],
    ["another origin", () => (child.document.nodePrincipal = { originNoSuffix: "https://evil.test" })],
    ["the form's action moved", () => (form.actionUrl = "https://evil.test/steal")],
    ["the type changed", () => (field().type = "text")],
    ["the autocomplete changed", () => (field().attrs.autocomplete = "username")],
    ["the field went hidden", () => (field().hidden = true)],
    ["the document went into the back-forward cache", () => (child.windowContext = { innerWindowId: 7, isInBFCache: true })],
    ["moved to another form with the same action", () => other.append(field())],
    ["detached", () => field().remove()],
  ];
  for (const [what, change] of cases) {
    const before = field() ?? (other.children[0] as El);
    // Each case starts from the field in place again.
    form.append(before);
    Object.assign(before, { type: "password", hidden: false, value: "", attrs: {} });
    form.actionUrl = ORIGIN + "/login";
    child.windowContext = { innerWindowId: 7, isInBFCache: false };
    child.document.nodePrincipal = { originNoSuffix: ORIGIN };
    const s = seal(0);
    change(s);
    expect(fill(s, "x"), what).toBe("changed");
    expect(before.value, what).toBe("");
  }
});

test("fill: the sealed field detached and an identical one put in its place is not the field sealed", () => {
  const { body, fields, seal, fill } = setup();
  const form = new Form(ORIGIN + "/login");
  const sealed = input("password", { name: "p" });
  body.append(form.append(sealed));
  fields();
  const s = seal(0);
  const twin = input("password", { name: "p" });
  sealed.replaceWith(twin);
  expect(fill(s, "x")).toBe("changed");
  expect(twin.value).toBe("");
  // Read again, the twin is a new field with its own number.
  expect(fields()).toEqual([{ n: 1, type: "password", autocomplete: "", label: "p" }]);
});

test("facts: the action is the form's, unless a submit control of it sends to another origin; null without a form", () => {
  const { body, fields, facts } = setup();
  const form = new Form(ORIGIN + "/login");
  const loose = input("text");
  body.append(form.append(input("text")), loose);
  fields();
  expect(facts(0)!.action).toBe(ORIGIN + "/login");
  expect(facts(1)!.action).toBeNull();
  // A formaction to the same origin, or on a control that does not submit, changes nothing.
  form.append(new El("button", { type: "submit", formAction: ORIGIN + "/other", attrs: { formaction: "/other" } }));
  form.append(new El("button", { type: "button", formAction: "https://evil.test/", attrs: { formaction: "https://evil.test/" } }));
  expect(facts(0)!.action).toBe(ORIGIN + "/login");
  // A submit image outside the form, tied to it with form=: the other origin wins.
  body.append(new El("input", { type: "image", owner: form, formAction: "https://evil.test/x", attrs: { formaction: "https://evil.test/x" } }));
  expect(facts(0)!.action).toBe("https://evil.test");
});

test("fill: a formaction added after the seal changes the action, nothing is written", () => {
  const { body, fields, seal, fill } = setup();
  const form = new Form(ORIGIN + "/login");
  const field = input("text");
  body.append(form.append(field));
  fields();
  const s = seal(0);
  form.append(new El("button", { type: "submit", formAction: "https://evil.test/x", attrs: { formaction: "https://evil.test/x" } }));
  expect(fill(s, "x")).toBe("changed");
  expect(field.value).toBe("");
});

test("an unknown handle, a non-string value or a malformed seal writes nothing", () => {
  const { body, fields, facts, seal, fill } = setup();
  body.append(input("text"));
  fields();
  expect(facts(9)).toBeNull();
  expect(fill(seal(0), 3 as unknown as string)).toBe("changed");
  expect(fill(null as unknown as object, "x")).toBe("changed");
  expect(fill({ ...seal(0), handle: "0" }, "x")).toBe("changed");
});

test("fill: a seal keeps its own placement; the page cannot have a later prepare re-place it", () => {
  const { body, fields, seal, fill } = setup();
  const form = new Form(ORIGIN + "/login");
  const other = new Form(ORIGIN + "/login");
  const field = input("password");
  body.append(form.append(field), other);
  fields();
  const approved = seal(0);
  // The bypass: moved into a form with the same action, then sealed again on the same handle.
  other.append(field);
  const later = seal(0);
  expect(fill(approved, "x")).toBe("changed");
  expect(field.value).toBe("");
  // The later seal matches where the field is now.
  expect(fill(later, "y")).toBe("filled");
  // A seal with another handle's placement token is not good either.
  const second = input("text");
  other.append(second);
  fields();
  expect(fill({ ...seal(1), placement: seal(0).placement }, "z")).toBe("changed");
});

test("fill: a field moved among its siblings, same parent and form, is not the field sealed", () => {
  const { body, fields, seal, fill } = setup();
  const form = new Form(ORIGIN + "/login");
  const user = input("text", { name: "u" });
  const pass = input("password", { name: "p" });
  body.append(form.append(user, pass));
  fields();
  const s = seal(1);
  // The password field put first: same parent, same form, another place.
  form.children.reverse();
  expect(fill(s, "x")).toBe("changed");
  expect(pass.value).toBe("");
});

test("facts: a login field names its form's other login field as Firefox's form detection pairs them, only if listed", () => {
  const { body, child, fields, facts } = setup();
  const form = new Form(ORIGIN + "/login");
  // No autocomplete on the username: only Firefox's pairing says what it is.
  const user = input("text");
  const pass = input("password");
  const code = input("text", { name: "code" });
  body.append(form.append(user, pass), code);
  child.manager = {
    getActor: (name: string) => {
      if (name !== "LoginManager") throw new Error("no actor");
      return { stateForDocument: (d: unknown) => (d === child.document ? { getUserNameAndPasswordFields: () => [user, pass, null] } : null) };
    },
  };
  expect(facts(0)).toBeNull();
  fields();
  expect(facts(0)).toMatchObject({ partner: 1, role: "username" });
  expect(facts(1)).toMatchObject({ partner: 0, role: "password" });
  expect(facts(2)).toMatchObject({ partner: null, role: null });
  // A partner the read never numbered, or no password field: no pair.
  const late = input("password");
  child.manager.getActor = () => ({ stateForDocument: () => ({ getUserNameAndPasswordFields: () => [user, late, null] }) });
  expect(facts(0)).toMatchObject({ partner: null, role: null });
  child.manager.getActor = () => ({ stateForDocument: () => ({ getUserNameAndPasswordFields: () => [user, null, null] }) });
  expect(facts(0)).toMatchObject({ partner: null, role: null });
  // Without Firefox's login actor: none.
  child.manager = undefined;
  expect(facts(1)).toMatchObject({ partner: null, role: null });
});

test("fill: the pairing is part of the seal; a pair changed between the card and the write writes nothing", () => {
  const { body, child, fields, seal, fill } = setup();
  const form = new Form(ORIGIN + "/login");
  const user = input("text");
  const pass = input("password");
  const other = input("password");
  body.append(form.append(user, pass), other);
  let paired = pass;
  child.manager = { getActor: () => ({ stateForDocument: () => ({ getUserNameAndPasswordFields: () => [user, paired, null] }) }) };
  fields();
  const s = seal(0);
  expect(s).toMatchObject({ partner: 1, role: "username" });
  paired = other;
  expect(fill(s, "moi")).toBe("changed");
  expect(user.value).toBe("");
  paired = pass;
  expect(fill(seal(0), "moi")).toBe("filled");
});
