import { expect, test } from "vitest";
import {
  urlChanged,
  urlUnchanged,
  urlNotFound,
  HomeMessage,
  editWithAgent,
} from "../../shared/sites";

test("messages of a site app's window", () => {
  expect(urlNotFound("adresses.localhost")).toBe("Adresse introuvable sur adresses.localhost");
  expect(urlChanged("Vidola", "vidola-b.localhost")).toBe("Vidola a changé d'adresse : vidola-b.localhost. Il faudra peut-être te reconnecter.");
  expect(urlUnchanged("Vidola")).toBe("Vidola ne répond pas, et sa page de référence donne toujours la même adresse");
  expect(editWithAgent("vidola")).toBe("Appli de site ~/Ressac/sites/vidola/ : ");
});

test("HomeMessage: the three allowed messages", () => {
  expect(HomeMessage.parse({ type: "ready" })).toEqual({ type: "ready" });
  expect(HomeMessage.parse({ type: "open", url: "/series/the-bear" })).toEqual({ type: "open", url: "/series/the-bear" });
  expect(HomeMessage.parse({ type: "image", n: 3, url: "https://vidola-a.localhost/a.jpg" })).toEqual({ type: "image", n: 3, url: "https://vidola-a.localhost/a.jpg" });
});

test("HomeMessage: the rest is refused", () => {
  for (const m of [
    null,
    "ready",
    {},
    { type: "fermer" },
    { type: "ready", in: "trop" },
    { type: "open" },
    { type: "open", url: 3 },
    { type: "open", url: "x".repeat(4097) },
    { type: "image", n: -1, url: "a" },
    { type: "image", n: 1.5, url: "a" },
    { type: "image", n: 1, url: "x".repeat(4097) },
    { type: "image", n: 1 },
  ]) {
    expect(HomeMessage.safeParse(m).success).toBe(false);
  }
});
