import { beforeEach, expect, test } from "vitest";
import { PolitiqueAcces } from "../../src/acces/politique.js";
import type { OngletInfo } from "../../src/mcp/pont.js";

const github: OngletInfo = { id: "1", titre: "svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: OngletInfo = { id: "2", titre: "Gmail", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const demo: OngletInfo = { id: "3", titre: "Démo", url: "http://localhost:5170/", espace: "perso" };
let p: PolitiqueAcces;
beforeEach(() => (p = new PolitiqueAcces()));

test("aucun accès par défaut", () => {
  expect(p.peutLire(gmail)).toBe(false);
});

test("interaction depuis un onglet → accès à cet onglet seulement", () => {
  p.interactionUtilisateur(github);
  expect(p.peutLire(github)).toBe(true);
  expect(p.peutLire(gmail)).toBe(false);
});

test("onglet ouvert par l'agent → accès", () => {
  p.ongletOuvertParAgent(demo);
  expect(p.peutLire(demo)).toBe(true);
});

test("accorder (réponse oui à une demande) → accès", () => {
  p.accorder(gmail);
  expect(p.peutLire(gmail)).toBe(true);
});

test("L'utilisateur change de site → autorisation caduque, même s'il revient", () => {
  p.interactionUtilisateur(github);
  p.ongletNavigue(github.id, "https://mail.google.com/");
  expect(p.peutLire({ ...github, url: "https://mail.google.com/" })).toBe(false);
  p.ongletNavigue(github.id, github.url);
  expect(p.peutLire(github)).toBe(false);
});

test("même site, autre page → accès conservé", () => {
  p.interactionUtilisateur(github);
  p.ongletNavigue(github.id, "https://github.com/sveltejs/kit");
  expect(p.peutLire({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

test("l'URL actuelle compte même sans événement de navigation", () => {
  p.interactionUtilisateur(github);
  expect(p.peutLire({ ...github, url: "https://evil.test/" })).toBe(false);
});

test("l'agent navigue son onglet de démo vers un autre port → accès conservé", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "http://localhost:5171/");
  expect(p.peutLire({ ...demo, url: "http://localhost:5171/" })).toBe(true);
});

test("reinitialiser retire tout ; ongletFerme retire l'onglet", () => {
  p.interactionUtilisateur(github);
  p.accorder(gmail);
  p.ongletFerme(gmail.id);
  expect(p.peutLire(gmail)).toBe(false);
  expect(p.peutLire(github)).toBe(true);
  p.reinitialiser();
  expect(p.peutLire(github)).toBe(false);
});

test("URL invalide → jamais lisible", () => {
  p.accorder({ ...github, url: "pas une url" });
  expect(p.peutLire({ ...github, url: "pas une url" })).toBe(false);
});
