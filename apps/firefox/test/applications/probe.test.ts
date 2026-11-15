import { expect, test, vi } from "vitest";
import { DockerProbe } from "../../core/applications/probe";

/** A probe that the test finishes by hand. */
function manualProbe() {
  const ends: ((e: string) => void)[] = [];
  const probe = vi.fn(() => new Promise<string>((r) => ends.push(r)));
  return { probe: probe, finish: (e: string) => ends.shift()!(e) };
}
const wait = () => new Promise((r) => setTimeout(r, 0));

test("valeur() never waits for the probe, and only starts one at a time", async () => {
  const { probe, finish } = manualProbe();
  const onChange = vi.fn();
  let t = 0;
  const s = new DockerProbe({ probe: probe, onChange: onChange, freshnessMs: 5000, now: () => t });
  expect(s.value()).toBe("ok");
  expect(s.value()).toBe("ok");
  expect(probe).toHaveBeenCalledTimes(1);
  finish("docker-absent");
  await wait();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(s.value()).toBe("docker-absent");
  // Result served again while it is fresh.
  t = 4999;
  s.value();
  expect(probe).toHaveBeenCalledTimes(1);
  t = 5000;
  expect(s.value()).toBe("docker-absent");
  expect(probe).toHaveBeenCalledTimes(2);
  finish("docker-absent");
  await wait();
  // Same state: no rebroadcast.
  expect(onChange).toHaveBeenCalledTimes(1);
});

test("a probe that fails counts as docker-absent", async () => {
  const onChange = vi.fn();
  const s = new DockerProbe({ probe: () => Promise.reject(new Error("x")), onChange: onChange });
  s.value();
  await wait();
  expect(s.value()).toBe("docker-absent");
  expect(onChange).toHaveBeenCalledTimes(1);
});
