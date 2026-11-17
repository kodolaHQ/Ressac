import { expect, test } from "vitest";
import { decisionNavigation, homeOpenUrl, openDecision, type NavigationContext } from "../../core/sites/navigation";
import { HOME_OPEN_GAP_MS } from "../../shared/sites";

const c: NavigationContext = { domains: ["vidola-a.example"], login: ["accounts.google.com"] };

test("main frame: the site and its subdomains are followed, the rest blocked", () => {
  expect(decisionNavigation("https://www.vidola-a.example/x", c)).toBe("follow");
  expect(decisionNavigation("https://vidola-a.example/", c)).toBe("follow");
  expect(decisionNavigation("https://pub.example/", c)).toBe("block");
  // The site name in the path, the identifier or a neighbouring domain is not enough.
  expect(decisionNavigation("https://pub.example/vidola-a.example", c)).toBe("block");
  expect(decisionNavigation("https://vidola-a.example@pub.example/", c)).toBe("block");
  expect(decisionNavigation("https://vidola-a.example.pub.example/", c)).toBe("block");
  expect(decisionNavigation("https://faux-vidola-a.example/", c)).toBe("block");
});

test("main frame: a sign-in domain is followed", () => {
  expect(decisionNavigation("https://accounts.google.com/o/oauth2", c)).toBe("follow");
  expect(decisionNavigation("https://accounts.google.com/o/oauth2", { ...c, login: [] })).toBe("block");
});

test("main frame: http(s) only", () => {
  for (const url of ["javascript:alert(1)", "about:blank", "file:///etc/passwd", "data:text/html,x", "ftp://vidola-a.example/", "pas une adresse", ""]) {
    expect(decisionNavigation(url, c)).toBe("block");
  }
});

test("openings: the site in the app, sign-in in a small window, the rest blocked", () => {
  expect(openDecision("https://www.vidola-a.example/serie", c)).toBe("in-app");
  expect(openDecision("https://accounts.google.com/o/oauth2", c)).toBe("small-window");
  for (const url of ["https://pub.example/", "about:blank", "javascript:alert(1)", "", "file:///x"]) {
    expect(openDecision(url, c)).toBe("block");
  }
  // A domain that is both the site's and the sign-in's stays in the app.
  expect(openDecision("https://vidola-a.example/", { ...c, login: ["vidola-a.example"] })).toBe("in-app");
});

test("credentials in the address: always blocked, even toward the site", () => {
  for (const url of ["https://u:p@www.vidola-a.example/", "https://u@vidola-a.example/", "https://:p@accounts.google.com/"]) {
    expect(decisionNavigation(url, c)).toBe("block");
    expect(openDecision(url, c)).toBe("block");
  }
});

test("http: never outside test mode, even toward the site", () => {
  expect(decisionNavigation("http://www.vidola-a.example/", c)).toBe("block");
  expect(openDecision("http://www.vidola-a.example/", c)).toBe("block");
  expect(decisionNavigation("http://accounts.google.com/", c)).toBe("block");
});

test("local addresses: refused outside test mode, even if a list contains them", () => {
  const locales: NavigationContext = { domains: ["vidola-a.localhost", "127.0.0.1", "nas.local"], login: ["192.168.1.1"] };
  for (const url of ["https://vidola-a.localhost/", "http://vidola-a.localhost/", "https://127.0.0.1/", "https://nas.local/", "https://192.168.1.1/"]) {
    expect(decisionNavigation(url, locales)).toBe("block");
    expect(openDecision(url, locales)).toBe("block");
  }
});

test("test mode: a local host's http allowed; a public host's http always refused", () => {
  const t: NavigationContext = { domains: ["vidola-a.localhost", "vidola-a.example"], login: ["connexion.localhost"], localAddresses: true };
  expect(decisionNavigation("http://vidola-a.localhost:4321/x", t)).toBe("follow");
  expect(openDecision("http://www.vidola-a.localhost:4321/x", t)).toBe("in-app");
  expect(openDecision("http://connexion.localhost:4321/", t)).toBe("small-window");
  expect(decisionNavigation("https://vidola-a.example/", t)).toBe("follow");
  expect(decisionNavigation("http://vidola-a.example/", t)).toBe("block");
  expect(openDecision("http://pub.localhost:4321/", t)).toBe("block");
  expect(decisionNavigation("http://u:p@vidola-a.localhost:4321/", t)).toBe("block");
});

test("a home's open: on the app's domains, at most one per HOME_OPEN_GAP_MS, never a non-string", () => {
  const site = { domains: ["vidola-a.example"], start: "https://vidola-a.example/" };
  expect(homeOpenUrl("/films", site, -Infinity, 5000, false)).toBe("https://vidola-a.example/films");
  expect(homeOpenUrl("https://www.vidola-a.example/x", site, -Infinity, 5000, false)).toBe("https://vidola-a.example/x");
  expect(homeOpenUrl("https://pub.example/", site, -Infinity, 5000, false)).toBeNull();
  expect(homeOpenUrl(42, site, -Infinity, 5000, false)).toBeNull();
  // Just after the last open: refused; once the gap is over: allowed.
  expect(homeOpenUrl("/films", site, 5000 - HOME_OPEN_GAP_MS + 1, 5000, false)).toBeNull();
  expect(homeOpenUrl("/films", site, 5000 - HOME_OPEN_GAP_MS, 5000, false)).toBe("https://vidola-a.example/films");
});
