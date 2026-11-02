import { expect, test } from "vitest";
import { DUREE_MIN_REPRISE_S, ECART_POSITION_MS, RECUL_REPRISE_S, SuiviReprise } from "../../src/preload/reprise";

/** Un suivi avec une horloge du test et la position que rend le process principal. */
function suivi(connue: number | null = null) {
  const notes: [number, number][] = [];
  const fins: boolean[] = [];
  const durees: number[] = [];
  let demandes = 0;
  let maintenant = 0;
  let reponse: (p: number | null) => void = () => {};
  let differee = false;
  const s = new SuiviReprise({
    noter: (t, duree, fin) => {
      notes.push([t, duree]);
      fins.push(fin);
    },
    demander: (duree) => {
      demandes++;
      durees.push(duree);
      return differee ? new Promise((ok) => (reponse = ok)) : Promise.resolve(connue);
    },
    maintenant: () => maintenant,
  });
  return {
    s,
    notes,
    fins,
    durees,
    demandes: () => demandes,
    horloge: (ms: number) => void (maintenant = ms),
    differer: () => void (differee = true),
    repondre: (p: number | null) => reponse(p),
  };
}

test("les valeurs du plan", () => {
  expect([DUREE_MIN_REPRISE_S, ECART_POSITION_MS, RECUL_REPRISE_S]).toEqual([60, 10_000, 5]);
});

test("timeupdate toutes les secondes pendant 35 s : 4 noter (0, 10, 20, 30 s)", async () => {
  const { s, notes, horloge } = suivi();
  const cle = {};
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle })).toBeNull();
  for (let t = 0; t <= 35; t++) {
    horloge(t * 1000);
    expect(await s.surEvenement("timeupdate", { currentTime: t, duration: 1500, cle })).toBeNull();
  }
  expect(notes).toEqual([
    [0, 1500],
    [10, 1500],
    [20, 1500],
    [30, 1500],
  ]);
});

test("pause : noter tout de suite ; ended aussi, marqué comme la fin", async () => {
  const { s, notes, fins, horloge } = suivi();
  const cle = {};
  await s.surEvenement("play", { currentTime: 0, duration: 1500, cle });
  await s.surEvenement("timeupdate", { currentTime: 1, duration: 1500, cle });
  horloge(2000);
  await s.surEvenement("pause", { currentTime: 2, duration: 1500, cle });
  horloge(2500);
  await s.surEvenement("ended", { currentTime: 1500, duration: 1500, cle });
  expect(notes).toEqual([
    [1, 1500],
    [2, 1500],
    [1500, 1500],
  ]);
  expect(fins).toEqual([false, false, true]);
});

test("vidéo de 30 s : rien noté, rien repris", async () => {
  const { s, notes, demandes } = suivi(20);
  const cle = {};
  for (const type of ["loadedmetadata", "play", "timeupdate", "pause", "ended"] as const) {
    expect(await s.surEvenement(type, { currentTime: 12, duration: 30, cle })).toBeNull();
  }
  expect(notes).toEqual([]);
  expect(demandes()).toBe(0);
});

test("durée non finie (direct) ou absente : ignorée", async () => {
  const { s, notes, demandes } = suivi(100);
  const cle = {};
  for (const duration of [Infinity, NaN]) {
    expect(await s.surEvenement("play", { currentTime: 10, duration, cle })).toBeNull();
    await s.surEvenement("pause", { currentTime: 10, duration, cle });
  }
  expect(notes).toEqual([]);
  expect(demandes()).toBe(0);
});

test("play avec position 1390 connue : rend 1385, une seule fois", async () => {
  const { s, demandes, durees } = suivi(1390);
  const cle = {};
  expect(await s.surEvenement("loadedmetadata", { currentTime: 0, duration: 1500, cle })).toBe(1385);
  expect(durees).toEqual([1500]);
  expect(await s.surEvenement("play", { currentTime: 1385, duration: 1500, cle })).toBeNull();
  expect(await s.surEvenement("loadedmetadata", { currentTime: 1385, duration: 1500, cle })).toBeNull();
  expect(demandes()).toBe(1);
  // Un autre élément de la page (lecteur recréé) demande pour lui-même, avec sa durée ; le main décide s'il la sert.
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBe(1385);
  expect(demandes()).toBe(2);
});

test("position 3 : rend 0", async () => {
  const { s } = suivi(3);
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBe(0);
});

test("une position au-delà de la durée de cette vidéo, ou qui n'est pas un nombre : rien repris", async () => {
  expect(await suivi(2000).s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBeNull();
  expect(await suivi(Number.NaN).s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBeNull();
});

test("rien n'est noté avant que la reprise soit réglée : un timeupdate à 0 s n'écrase pas la position", async () => {
  const { s, notes, differer, repondre, horloge } = suivi();
  differer();
  const cle = {};
  const reprise = s.surEvenement("play", { currentTime: 0, duration: 1500, cle });
  expect(await s.surEvenement("timeupdate", { currentTime: 0, duration: 1500, cle })).toBeNull();
  expect(await s.surEvenement("pause", { currentTime: 0, duration: 1500, cle })).toBeNull();
  expect(notes).toEqual([]);
  repondre(1390);
  expect(await reprise).toBe(1385);
  horloge(100);
  await s.surEvenement("timeupdate", { currentTime: 1385, duration: 1500, cle });
  expect(notes).toEqual([[1385, 1500]]);
});

test("une demande qui échoue : rien repris, le suivi continue", async () => {
  const notes: number[] = [];
  const s = new SuiviReprise({ noter: (t) => void notes.push(t), demander: () => Promise.reject(new Error("x")), maintenant: () => 0 });
  const cle = {};
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle })).toBeNull();
  await s.surEvenement("pause", { currentTime: 4, duration: 1500, cle });
  expect(notes).toEqual([4]);
});

test("la durée connue plus tard (flux) : la reprise est demandée au premier événement où elle est finie", async () => {
  const { s, demandes } = suivi(500);
  const cle = {};
  expect(await s.surEvenement("loadedmetadata", { currentTime: 0, duration: Infinity, cle })).toBeNull();
  expect(await s.surEvenement("timeupdate", { currentTime: 0.2, duration: 1500, cle })).toBe(495);
  expect(demandes()).toBe(1);
});
