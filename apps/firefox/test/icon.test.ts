import { expect, test } from "vitest";
import { iconUrl } from "../shared/icon";

test("iconUrl: data: and Firefox's moz-remote-image: (SVG icons) stay, http(s) goes through webaios-icone:, the rest is refused", () => {
  expect(iconUrl("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
  expect(iconUrl("moz-remote-image://?url=data%3Aimage%2Fsvg%2Bxml&width=16")).toBe("moz-remote-image://?url=data%3Aimage%2Fsvg%2Bxml&width=16");
  expect(iconUrl("https://a.example/favicon.ico")).toBe("webaios-icone://site/?u=https%3A%2F%2Fa.example%2Ffavicon.ico");
  expect(iconUrl("data:text/html,x")).toBeNull();
  expect(iconUrl("chrome://browser/skin/x.svg")).toBeNull();
});
