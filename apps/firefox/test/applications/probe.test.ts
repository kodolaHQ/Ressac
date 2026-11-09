import { expect, test, vi } from "vitest";
import { DockerProbe } from "../../core/applications/probe";

/** A probe that the test finishes by hand. */
function manualProbe() {
  const ends: ((e: string) => void)[] = [];
  const probe = vi.fn(() => new Promise<string>((r) => ends.push(r)));
  return { sonder: probe, finir: (e: string) => ends.shift()!(e) };
}
const wait = () => new Promise((r) => setTimeout(r, 0));

test("valeur() never waits for the probe, and only starts one at a time", async () => {
  const { sonder: probe, finir: finish } = manualProbe();
  const onChange = vi.fn();
  let t = 0;
  const s = new DockerProbe({ sonder: probe, surChange: onChange, fraicheurMs: 5000, maintenant: () => t });
  expect(s.valeur()).toBe("ok");
  expect(s.valeur()).toBe("ok");
  expect(probe).toHaveBeenCalledTimes(1);
  finish("docker-absent");
  await wait();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(s.valeur()).toBe("docker-absent");
  // Result served again while it is fresh.
  t = 4999;
  s.valeur();
  expect(probe).toHaveBeenCalledTimes(1);
  t = 5000;
  expect(s.valeur()).toBe("docker-absent");
  expect(probe).toHaveBeenCalledTimes(2);
  finish("docker-absent");
  await wait();
  // Same state: no rebroadcast.
  expect(onChange).toHaveBeenCalledTimes(1);
});

test("a probe that fails counts as docker-absent", async () => {
  const onChange = vi.fn();
  const s = new DockerProbe({ sonder: () => Promise.reject(new Error("x")), surChange: onChange });
  s.valeur();
  await wait();
  expect(s.valeur()).toBe("docker-absent");
  expect(onChange).toHaveBeenCalledTimes(1);
});
