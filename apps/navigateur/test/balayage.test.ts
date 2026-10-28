import { describe, expect, it } from "vitest";
import { ETAT_BALAYAGE, etapeBalayage, PAUSE_GESTE, SEUIL_BALAYAGE, type EtatBalayage, type Possible } from "../src/main/onglets/balayage";

const tout: Possible = { reculer: true, avancer: true };

/** Rejoue des défilements horizontaux de `dx` px, espacés de 16 ms. */
function geste(dxs: number[], possible = tout, depart: EtatBalayage = ETAT_BALAYAGE, t0 = 1000, pris = false) {
  let etat = depart;
  const actions: string[] = [];
  let progression = 0;
  dxs.forEach((dx, i) => {
    const r = etapeBalayage(etat, { dx, dy: 0, pris, t: t0 + i * 16 }, possible);
    etat = r.etat;
    progression = r.progression;
    if (r.action) actions.push(r.action);
  });
  return { etat, actions, progression };
}

describe("balayage à deux doigts", () => {
  it("vers la gauche au-delà du seuil recule, une seule fois pour tout le geste (élan compris)", () => {
    const { actions } = geste(Array(40).fill(-20));
    expect(actions).toEqual(["reculer"]);
  });

  it("vers la droite avance", () => {
    expect(geste(Array(20).fill(20)).actions).toEqual(["avancer"]);
  });

  it("sous le seuil, rien ; la progression suit le mouvement", () => {
    const r = geste([-40, -40]);
    expect(r.actions).toEqual([]);
    expect(r.progression).toBeCloseTo(-80 / SEUIL_BALAYAGE);
  });

  it("rien quand la page prend le défilement ou quand on ne peut pas reculer", () => {
    expect(geste(Array(20).fill(-20), tout, ETAT_BALAYAGE, 1000, true).actions).toEqual([]);
    expect(geste(Array(20).fill(-20), { reculer: false, avancer: true }).actions).toEqual([]);
  });

  it("un défilement surtout vertical remet à zéro", () => {
    let etat = geste([-100]).etat;
    etat = etapeBalayage(etat, { dx: -10, dy: 50, pris: false, t: 1020 }, tout).etat;
    expect(etat.cumul).toBe(0);
  });

  it("changer de sens repart de zéro dans le nouveau sens", () => {
    const r = geste([-120, 30]);
    expect(r.etat.cumul).toBe(30);
    expect(r.actions).toEqual([]);
  });

  it("après une pause, un nouveau geste peut naviguer à nouveau", () => {
    const premier = geste(Array(12).fill(-20));
    expect(premier.actions).toEqual(["reculer"]);
    const second = geste(Array(12).fill(-20), tout, premier.etat, premier.etat.dernier + PAUSE_GESTE + 1);
    expect(second.actions).toEqual(["reculer"]);
  });
});
