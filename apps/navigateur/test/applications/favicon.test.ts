import { expect, test, vi } from "vitest";
import { faviconEnDonnees, TAILLE_FAVICON } from "../../src/main/applications/favicon";

const PAGE = "http://localhost:15280/";
const image = (corps: BodyInit, entetes: Record<string, string> = {}) => vi.fn(async () => new Response(corps, { headers: { "content-type": "image/png", ...entetes } }));

test("un favicon de l'appli devient une adresse data:", async () => {
  expect(await faviconEnDonnees(image(new Uint8Array([1, 2, 3])), `${PAGE}favicon.png`, PAGE)).toBe("data:image/png;base64,AQID");
});

test("refusé : content-length trop grand, sans rien lire", async () => {
  const chercher = image(new Uint8Array(10), { "content-length": String(TAILLE_FAVICON + 1) });
  expect(await faviconEnDonnees(chercher, `${PAGE}f.png`, PAGE)).toBeUndefined();
});

test("refusé : un corps sans fin est coupé dès la borne dépassée", async () => {
  let envoyes = 0;
  const flot = new ReadableStream<Uint8Array>({
    pull(c) {
      envoyes += 16 * 1024;
      c.enqueue(new Uint8Array(16 * 1024));
    },
  });
  expect(await faviconEnDonnees(image(flot), `${PAGE}f.png`, PAGE)).toBeUndefined();
  expect(envoyes).toBeLessThan(TAILLE_FAVICON * 2);
});

test("refusé : fichier local, autre origine, pas une image", async () => {
  const chercher = image(new Uint8Array([1]));
  expect(await faviconEnDonnees(chercher, "file:///Users/x/photo.png", PAGE)).toBeUndefined();
  expect(await faviconEnDonnees(chercher, "http://localhost:15281/f.png", PAGE)).toBeUndefined();
  expect(await faviconEnDonnees(chercher, "https://ailleurs.test/f.png", PAGE)).toBeUndefined();
  expect(chercher).not.toHaveBeenCalled();
  const html = vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } }));
  expect(await faviconEnDonnees(html, `${PAGE}favicon.ico`, PAGE)).toBeUndefined();
});
