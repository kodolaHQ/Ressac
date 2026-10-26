import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { lancer } from "./aide";

test("la fenêtre s'ouvre sur la page d'accueil, avec la barre latérale, le contenu et le panneau agent", async () => {
  const { fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await expect(fenetre.getByTestId("zone-contenu")).toBeVisible();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fermer();
});

test("l'interface n'expose pas Node", async () => {
  const { fenetre, fermer } = await lancer();
  expect(await fenetre.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined");
  expect(await fenetre.evaluate(() => typeof (window as unknown as { webaios?: unknown }).webaios)).toBe("object");
  await fermer();
});

test("un second lancement sur le même profil s'arrête et laisse le premier intact", async () => {
  const { app, profil, fermer } = await lancer();
  const electronBin = require("electron") as unknown as string;
  const second = spawn(electronBin, [join(__dirname, "../out/main/index.js")], { env: { ...process.env, WEBAIOS_PROFIL: profil, WEBAIOS_INVISIBLE: "1" } });
  const code = await new Promise<number | null>((ok) => {
    const minuterie = setTimeout(() => {
      second.kill();
      ok(-1);
    }, 10_000);
    second.on("exit", (c) => {
      clearTimeout(minuterie);
      ok(c);
    });
  });
  expect(code).toBe(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await fermer();
});

test("si l'interface plante, elle se recharge au lieu de laisser une fenêtre blanche", async () => {
  const { app, fermer } = await lancer();
  await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((w) => w.getURL().includes("/renderer/index.html"))!
      .forcefullyCrashRenderer(),
  );
  await expect
    .poll(
      () =>
        app.evaluate(async ({ webContents }) => {
          const ui = webContents.getAllWebContents().find((w) => w.getURL().includes("/renderer/index.html"));
          if (!ui || ui.isCrashed()) return false;
          return ui.executeJavaScript("!!document.querySelector('[data-testid=barre-laterale]')").catch(() => false);
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
  await fermer();
});
