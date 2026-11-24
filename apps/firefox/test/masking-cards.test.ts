import { expect, it, vi } from "vitest";
import { initialState } from "../core/state/initial-state";
import { Questions } from "../chrome/agent/questions";
import { createStore } from "../chrome/store/store";
import { format } from "../shared/i18n";

// The masking cards (spec § 8): they name the value, never carry it; Touch ID runs after « Oui », and any failure is a no.
const VALUE = "482913";
const LABEL = "⟨code-1a2b3c4d⟩";

function setup(reauth: (reason: string) => Promise<boolean> = async () => true) {
  const store = createStore(initialState());
  const spy = vi.fn(reauth);
  const questions = new Questions(store, () => [], () => [], spy);
  return { store, questions, reauth: spy, win: store.state.windows[0]!.id };
}
const only = (q: Questions) => {
  const [p] = q.pending();
  expect(q.pending()).toHaveLength(1);
  return p!;
};

it("the reveal card names the value and its label, never the value; Montrer then Touch ID answers yes", async () => {
  const { questions, reauth, win } = setup();
  const card = { name: "votre code", reason: "payer", agent: "Claude", conversation: "c", text: "L'agent veut voir votre code pour cette tâche.", label: LABEL };
  const answer = questions.askReveal(card, win);
  const p = only(questions);
  expect(p).toMatchObject({ tabId: null, windowId: win, permissions: ["mask-reveal"], reason: "payer", agent: "Claude", mask: { name: "votre code", text: card.text, labels: [LABEL] } });
  expect(JSON.stringify(p)).not.toContain(VALUE);
  expect(reauth).not.toHaveBeenCalled();
  questions.answer(p.id, "allow");
  expect(await answer).toBe(true);
  expect(reauth).toHaveBeenCalledTimes(1);
  expect(reauth.mock.calls[0]![0]).toContain("votre code");
});

it("the reveal card: a refusal skips Touch ID; a failed, cancelled or broken Touch ID is a no", async () => {
  for (const reauth of [async () => false, async () => Promise.reject(new Error("annulé"))]) {
    const { questions, win } = setup(reauth);
    const answer = questions.askReveal({ name: "votre code", reason: "r", agent: "A", text: "t", label: LABEL }, win);
    questions.answer(only(questions).id, "allow");
    expect(await answer).toBe(false);
  }
  const { questions, reauth, win } = setup();
  const answer = questions.askReveal({ name: "votre code", reason: "r", agent: "A", text: "t", label: LABEL }, win);
  questions.answer(only(questions).id, "deny");
  expect(await answer).toBe(false);
  expect(reauth).not.toHaveBeenCalled();
});

it("the reveal card: its signal raised during Touch ID answers no", async () => {
  const ac = new AbortController();
  const { questions, win } = setup(async () => (ac.abort(), true));
  const answer = questions.askReveal({ name: "votre code", reason: "r", agent: "A", text: "t", label: LABEL }, win, ac.signal);
  questions.answer(only(questions).id, "allow");
  expect(await answer).toBe(false);
});

it("the fill card: Touch ID only when asked, the red lines shown, a chosen login bounded to the list", async () => {
  const { questions, reauth, win } = setup();
  const fill = { name: "votre mot de passe", field: "Mot de passe", where: "https://a.test/connexion", touchId: false, labels: [], loginCount: 2, loginsRef: "ref-1", agent: "A", danger: "Conversation verrouillée." };
  let answer = questions.askFill(fill, win);
  const p = only(questions);
  expect(p).toMatchObject({ permissions: ["mask-fill"], origin: "https://a.test/connexion", danger: fill.danger, mask: { name: fill.name, field: fill.field, where: fill.where, loginCount: 2, loginsRef: "ref-1", labels: [] } });
  // The usernames never come with the card: only their count and the host's reference.
  expect(JSON.stringify(p)).not.toMatch(/camille|dominique/);
  questions.answer(p.id, "allow", { login: 1 });
  expect(await answer).toEqual({ yes: true, login: 1 });
  expect(reauth).not.toHaveBeenCalled();

  answer = questions.askFill(fill, win);
  questions.answer(only(questions).id, "allow", { login: 7 });
  expect(await answer).toEqual({ yes: true });

  answer = questions.askFill({ ...fill, loginCount: undefined, loginsRef: undefined, labels: [LABEL], touchId: true }, win);
  expect(only(questions)).not.toHaveProperty("mask.loginCount");
  questions.answer(only(questions).id, "deny");
  expect(await answer).toEqual({ yes: false });
  expect(reauth).not.toHaveBeenCalled();
});

it("the fill card with Touch ID: a failed one is a no", async () => {
  const { questions, reauth, win } = setup(async () => false);
  const answer = questions.askFill({ name: "un code", field: "Code", where: "https://a.test/", touchId: true, labels: [LABEL], agent: "A" }, win);
  questions.answer(only(questions).id, "allow");
  expect(await answer).toEqual({ yes: false });
  expect(reauth).toHaveBeenCalledTimes(1);
});

it("the label alert: no Touch ID, yes only on its button", async () => {
  const { questions, reauth, win } = setup();
  const alert = { name: "votre code", destination: "votre moteur de recherche", text: "L'agent envoie l'étiquette de votre code (sans la valeur) vers votre moteur de recherche." };
  let answer = questions.askLabelAlert(alert, win);
  expect(only(questions)).toMatchObject({ permissions: ["mask-label-alert"], mask: { name: alert.name, text: alert.text } });
  questions.answer(only(questions).id, "deny");
  expect(await answer).toBe(false);
  answer = questions.askLabelAlert(alert, win);
  questions.answer(only(questions).id, "allow");
  expect(await answer).toBe(true);
  expect(reauth).not.toHaveBeenCalled();
});

it("the dev tools unlock: Touch ID after Débloquer; it falls when the tab goes to another site", async () => {
  const { store, questions, reauth, win } = setup();
  store.dispatch({ type: "openTab", windowId: win, url: "https://a.test/", activate: true }, () => "t");
  const o = { id: "t", title: "A", url: "https://a.test/", space: "" };
  const d = { agent: "Claude", text: "Les outils de développement verraient vos données en clair." };
  let answer = questions.askDevUnlock(o, d, win);
  expect(only(questions)).toMatchObject({ permissions: ["mask-devtools"], target: "t", origin: "https://a.test", title: "A", agent: "Claude", mask: { text: d.text } });
  questions.answer(only(questions).id, "allow");
  expect(await answer).toBe(true);
  expect(reauth).toHaveBeenCalledTimes(1);

  answer = questions.askDevUnlock(o, d, win);
  store.dispatch({ type: "updateTab", id: "t", fields: { url: "https://b.test/" } });
  expect(await answer).toBe(false);
  expect(questions.pending()).toEqual([]);
});

// Passport fill cards (design § 8.3-8.4, § 9.5): chrome writes the texts; the choices come by reference, masked.
const SHOWN = "1• r•• d•• T•••••••";
function passportSetup(reauth: (reason: string) => Promise<boolean> = async () => true) {
  const base = initialState();
  const work = { ...base.spaces[0]!, id: "w", name: "Travail", profile: "p-work" };
  const store = createStore({ ...base, locale: "fr", spaces: [...base.spaces, work], profiles: [...base.profiles, { id: "p-work" }] });
  const spy = vi.fn(reauth);
  return { questions: new Questions(store, () => [], () => [], spy), reauth: spy, win: store.state.windows[0]!.id };
}
const passportFill = { name: "votre adresse", field: "Adresse", where: "https://boutique.test/commande", touchId: false, labels: [], agent: "A" };

it("a passport value of another profile: the card names that passport by its spaces", async () => {
  const { questions, win } = passportSetup();
  const answer = questions.askFill({ ...passportFill, labels: [LABEL], passportProfile: "p-work" }, win);
  expect(only(questions).mask?.note).toBe("Cette donnée vient de votre passeport « Travail », pas de celui de cet onglet.");
  questions.answer(only(questions).id, "deny");
  expect(await answer).toEqual({ yes: false });
});

it("a kind fill: its title, one line per row, the only choice picked by itself", async () => {
  const { questions, win } = passportSetup();
  const answer = questions.askFill({ ...passportFill, rows: [{ field: "Adresse", name: "votre adresse", kind: "adresse", choices: [{ ref: "r1", shown: SHOWN }] }] }, win);
  const p = only(questions);
  expect(p.mask).toMatchObject({ text: "Remplir votre adresse sur boutique.test ?", rows: [{ line: "Adresse : votre adresse", choices: [{ ref: "r1", shown: SHOWN }] }] });
  questions.answer(p.id, "allow");
  expect(await answer).toEqual({ yes: true, picks: ["r1"] });
});

it("several fields on one card: its title, a line per row, one Touch ID, the picked ref per row", async () => {
  const { questions, reauth, win } = passportSetup();
  const rows = [
    { field: "Prénom", name: "votre prénom" },
    { field: "Adresse", name: "votre adresse", kind: "adresse", choices: [{ ref: "r1", shown: SHOWN }, { ref: "r2", shown: "2• a•••••" }] },
    { field: "Ville", name: "votre ville", kind: "ville", choices: [{ ref: "r3", shown: "L•••" }, { ref: "r4", shown: "P••••" }] },
  ];
  const answer = questions.askFill({ ...passportFill, labels: [LABEL], touchId: true, rows }, win);
  const p = only(questions);
  expect(p.mask?.text).toBe("Remplir 3 champs sur boutique.test avec votre passeport ?");
  expect(p.mask?.rows?.map((r) => r.line)).toEqual(["Prénom : votre prénom", "Adresse : votre adresse", "Ville : votre ville"]);
  // A pick of another row, or of nothing, is no pick.
  questions.answer(p.id, "allow", { picks: [null, "r2", "r1"] });
  expect(await answer).toEqual({ yes: true, picks: [null, "r2", null] });
  expect(reauth).toHaveBeenCalledTimes(1);
});

it("a kind with nothing to pick: « n'a pas de », and even a yes refuses, with no Touch ID", async () => {
  const { questions, reauth, win } = passportSetup();
  const answer = questions.askFill({ ...passportFill, touchId: true, rows: [{ field: "IBAN", name: "votre IBAN", kind: "iban", choices: [] }] }, win);
  expect(only(questions).mask?.rows).toEqual([{ line: "IBAN : votre IBAN", missing: "Votre passeport n'a pas d'IBAN." }]);
  questions.answer(only(questions).id, "allow");
  expect(await answer).toEqual({ yes: false });
  expect(reauth).not.toHaveBeenCalled();
});

it("several entries of a kind: none is picked for the user; a yes without a pick leaves that row unpicked", async () => {
  const { questions, win } = passportSetup();
  const rows = [{ field: "Adresse", name: "votre adresse", kind: "adresse", choices: [{ ref: "r1", shown: SHOWN }, { ref: "r2", shown: "2• a•••••" }] }];
  const answer = questions.askFill({ ...passportFill, rows }, win);
  questions.answer(only(questions).id, "allow");
  expect(await answer).toEqual({ yes: true, picks: [null] });
});

it("« Ouvrir le passeport » opens the other profile's passport, else the tab's", async () => {
  const { questions, win } = passportSetup();
  void questions.askFill({ ...passportFill, profile: "default", rows: [{ field: "IBAN", name: "votre IBAN", kind: "iban", choices: [] }] }, win);
  expect(only(questions).mask?.profile).toBe("default");
  questions.answer(only(questions).id, "deny");
  void questions.askFill({ ...passportFill, labels: [LABEL], passportProfile: "p-work" }, win);
  expect(only(questions).mask?.profile).toBe("p-work");
});

it("a kind the passport lacks: the sentence for each kind, and a plain one for an unknown kind", () => {
  const say = (kind: string) => format("fr", "chrome-mask-fill-missing", { kind });
  expect(say("secu")).toBe("Votre passeport n'a pas de numéro de sécu.");
  expect(say("adresse")).toBe("Votre passeport n'a pas d'adresse.");
  expect(say("")).toBe("Votre passeport n'a pas cette donnée.");
});

// « Retenir ce site » (task 13b): the card shows a box per row the kernel named, never its entry; a tick from the card's
// own window, on « Remplir » and its Touch ID, hands back the seal and entry for chrome to remember once written.
const AT = { seal: "s0", profile: "default", id: "0000000000000001" };
it("remember: one box per named row, its entry kept in chrome; unticked by default, a tick counts only on Remplir from the card's window", async () => {
  const { questions, reauth, win } = passportSetup();
  const card = { ...passportFill, labels: [LABEL], touchId: true, remember: [{ row: 0, ...AT }] };
  let answer = questions.askFill(card, win);
  let p = only(questions);
  expect(p.mask?.remember).toEqual([{ row: 0, text: "Retenir boutique.test pour votre adresse" }]);
  expect(JSON.stringify(p)).not.toContain(AT.id);
  questions.answer(p.id, "allow");
  expect(await answer).toEqual({ yes: true });
  answer = questions.askFill(card, win);
  questions.answer(only(questions).id, "allow", { remember: [0], window: win });
  expect(await answer).toEqual({ yes: true, remember: [AT] });
  // Refused, a failed Touch ID, or ticked from another window: nothing to remember.
  answer = questions.askFill(card, win);
  questions.answer(only(questions).id, "deny", { remember: [0], window: win });
  expect(await answer).toEqual({ yes: false });
  reauth.mockResolvedValueOnce(false);
  answer = questions.askFill(card, win);
  questions.answer(only(questions).id, "allow", { remember: [0], window: win });
  expect(await answer).toEqual({ yes: false });
  answer = questions.askFill(card, win);
  questions.answer(only(questions).id, "allow", { remember: [0], window: "another" });
  expect(await answer).toEqual({ yes: true });
  // A row the kernel did not name has no box to tick.
  answer = questions.askFill({ ...card, remember: undefined }, win);
  p = only(questions);
  expect(p.mask).not.toHaveProperty("remember");
  questions.answer(p.id, "allow", { remember: [0], window: win });
  expect(await answer).toEqual({ yes: true });
});

it("remember: a kind row's box follows the picked entry; with `also`, each row has its own", async () => {
  const { questions, win } = passportSetup();
  const rows = [
    { field: "Adresse", name: "votre adresse", kind: "adresse", choices: [{ ref: "r1", shown: SHOWN }, { ref: "r2", shown: "2• a•••••" }] },
    { field: "Prénom", name: "votre prénom", kind: "prenoms", choices: [{ ref: "r3", shown: "C••••••" }] },
  ];
  const remember = [
    { row: 0, choice: "r2", seal: "s0", profile: "default", id: "0000000000000002" },
    { row: 1, choice: "r3", seal: "s1", profile: "default", id: "0000000000000003" },
  ];
  let answer = questions.askFill({ ...passportFill, rows, remember }, win);
  expect(only(questions).mask?.remember).toEqual([
    { row: 0, choice: "r2", text: "Retenir boutique.test pour votre adresse" },
    { row: 1, choice: "r3", text: "Retenir boutique.test pour votre prénom" },
  ]);
  questions.answer(only(questions).id, "allow", { picks: ["r2", null], remember: [0, 1], window: win });
  expect(await answer).toEqual({ yes: true, picks: ["r2", "r3"], remember: remember.map(({ seal, profile, id }) => ({ seal, profile, id })) });
  // r1 picked: its entry has no box, the tick of row 0 is nothing.
  answer = questions.askFill({ ...passportFill, rows, remember }, win);
  questions.answer(only(questions).id, "allow", { picks: ["r1", null], remember: [0], window: win });
  expect(await answer).toEqual({ yes: true, picks: ["r1", "r3"] });
});
