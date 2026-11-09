import { expect, it } from "vitest";
import { bannerText } from "../chrome/window/banner-text";

const a = "https://a.test";

it("the sentences: camera and micro grouped, notifications, the link cut at 120", () => {
  expect(bannerText({ origin: a, permissions: ["media-camera", "media-micro"] })).toBe("a.test veut utiliser votre caméra et votre micro");
  expect(bannerText({ origin: a, permissions: ["notifications"] })).toBe("a.test veut vous envoyer des notifications");
  const link = `mailto:${"x".repeat(200)}`;
  expect(bannerText({ origin: a, permissions: ["open-app"], link: link })).toBe(`a.test veut ouvrir un lien dans une autre application : ${link.slice(0, 120)}`);
});

it("the three new kinds", () => {
  expect(bannerText({ origin: a, permissions: ["screen-share"] })).toBe("a.test veut partager votre écran");
  expect(bannerText({ origin: a, permissions: ["drm"] })).toBe("a.test veut lire des contenus protégés (DRM)");
  expect(bannerText({ origin: a, permissions: ["midi"] })).toBe("a.test veut utiliser vos appareils MIDI");
});
