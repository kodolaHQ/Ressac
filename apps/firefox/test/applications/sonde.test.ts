import { expect, test, vi } from "vitest";
import { DockerProbe } from "../../core/applications/sonde";

/** A probe that the test finishes by hand. */
function sondeManuelle() {
  const fins: ((e: string) => void)[] = [];
  const sonder = vi.fn(() => new Promise<string>((r) => fins.push(r)));
  return { sonder, finir: (e: string) => fins.shift()!(e) };
}
const attendre = () => new Promise((r) => setTimeout(r, 0));

test("valeur() never waits for the probe, and only starts one at a time", async () => {
  const { sonder, finir } = sondeManuelle();
  const surChange = vi.fn();
  let t = 0;
  const s = new DockerProbe({ sonder, surChange, fraicheurMs: 5000, maintenant: () => t });
  expect(s.valeur()).toBe("ok");
  expect(s.valeur()).toBe("ok");
  expect(sonder).toHaveBeenCalledTimes(1);
  finir("docker-absent");
  await attendre();
  expect(surChange).toHaveBeenCalledTimes(1);
  expect(s.valeur()).toBe("docker-absent");
  // Result served again while it is fresh.
  t = 4999;
  s.valeur();
  expect(sonder).toHaveBeenCalledTimes(1);
  t = 5000;
  expect(s.valeur()).toBe("docker-absent");
  expect(sonder).toHaveBeenCalledTimes(2);
  finir("docker-absent");
  await attendre();
  // Same state: no rebroadcast.
  expect(surChange).toHaveBeenCalledTimes(1);
});

test("a probe that fails counts as docker-absent", async () => {
  const surChange = vi.fn();
  const s = new DockerProbe({ sonder: () => Promise.reject(new Error("x")), surChange });
  s.valeur();
  await attendre();
  expect(s.valeur()).toBe("docker-absent");
  expect(surChange).toHaveBeenCalledTimes(1);
});
