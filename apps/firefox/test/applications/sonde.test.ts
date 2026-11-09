import { expect, test, vi } from "vitest";
import { SondeDocker } from "../../core/applications/sonde";

/** Une sonde que le test termine à la main. */
function sondeManuelle() {
  const fins: ((e: string) => void)[] = [];
  const sonder = vi.fn(() => new Promise<string>((r) => fins.push(r)));
  return { sonder, finir: (e: string) => fins.shift()!(e) };
}
const attendre = () => new Promise((r) => setTimeout(r, 0));

test("valeur() n'attend jamais la sonde, et n'en lance qu'une à la fois", async () => {
  const { sonder, finir } = sondeManuelle();
  const surChange = vi.fn();
  let t = 0;
  const s = new SondeDocker({ sonder, surChange, fraicheurMs: 5000, maintenant: () => t });
  expect(s.valeur()).toBe("ok");
  expect(s.valeur()).toBe("ok");
  expect(sonder).toHaveBeenCalledTimes(1);
  finir("docker-absent");
  await attendre();
  expect(surChange).toHaveBeenCalledTimes(1);
  expect(s.valeur()).toBe("docker-absent");
  // Résultat resservi tant qu'il est frais.
  t = 4999;
  s.valeur();
  expect(sonder).toHaveBeenCalledTimes(1);
  t = 5000;
  expect(s.valeur()).toBe("docker-absent");
  expect(sonder).toHaveBeenCalledTimes(2);
  finir("docker-absent");
  await attendre();
  // Même état : pas de rediffusion.
  expect(surChange).toHaveBeenCalledTimes(1);
});

test("une sonde qui échoue vaut docker-absent", async () => {
  const surChange = vi.fn();
  const s = new SondeDocker({ sonder: () => Promise.reject(new Error("x")), surChange });
  s.valeur();
  await attendre();
  expect(s.valeur()).toBe("docker-absent");
  expect(surChange).toHaveBeenCalledTimes(1);
});
