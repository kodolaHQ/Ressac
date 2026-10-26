import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { attendreChargement } from "../src/main/onglets/chargement";

function page(chargement: boolean) {
  return Object.assign(new EventEmitter(), { isLoading: () => chargement });
}

test("attendreChargement : rend la main à la fin du chargement", async () => {
  const wc = page(true);
  const fini = attendreChargement(wc, 1000);
  wc.emit("did-stop-loading");
  await fini;
  expect(wc.listenerCount("did-stop-loading")).toBe(0);
});

test("attendreChargement : au bout du délai, rend la main et ne laisse aucun écouteur", async () => {
  vi.useFakeTimers();
  try {
    const wc = page(true);
    const fini = attendreChargement(wc, 1000);
    vi.advanceTimersByTime(1000);
    await fini;
    expect(wc.listenerCount("did-stop-loading")).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("attendreChargement : une page déjà chargée n'attend pas", async () => {
  const wc = page(false);
  await attendreChargement(wc, 1000);
  expect(wc.listenerCount("did-stop-loading")).toBe(0);
});
