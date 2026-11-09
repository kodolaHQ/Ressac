import { expect, test, vi } from "vitest";
import { spacePaths, type Batch, type TrackedProject } from "@webaios/kernel";
import { NO_WINDOW, createSend } from "../../core/design/send";

const batch: Batch = {
  id: "20261102T101500Z-ab12",
  project: "app-essai",
  created: "2026-11-02T10:15:00Z",
  destination: "agent",
  items: [
    {
      id: "e-00000001",
      type: "design",
      text: "Champ\r\nplus large",
      capture: null,
      context: { selector: "#email", label: "input#email", html: "<input>", neighborhood: { parent: "", siblings: [] }, styles: {}, source: null, url: "http://localhost:15281/", view: { width: 1, height: 1 } },
    },
  ],
};

function mount() {
  const paths = spacePaths("/tmp/racine-envoi");
  const o = {
    paths: paths,
    agentWindow: vi.fn(() => "f7"),
    batchFolder: vi.fn((p: string, l: string) => `${paths.internal}/remarques/${p}/${l}`),
    prefill: vi.fn(),
    giveTerminal: vi.fn(),
    toFront: vi.fn(),
  };
  return { o, send: createSend(o) };
}

test("app: preRemplir receives the agent's window and the text, never a \r; external: preRemplir is not called", async () => {
  const { o, send: send } = mount();
  await send({ type: "app", project: "app-essai", folder: "essai", name: "Essai" }, batch);
  expect(o.prefill).toHaveBeenCalledTimes(1);
  const [f, text] = o.prefill.mock.calls[0]!;
  expect(f).toBe("f7");
  expect(text).toContain("appli Essai (/workspace/projects/essai)");
  expect(text).toContain("/workspace/.webaios/remarques/app-essai/20261102T101500Z-ab12/lot.json] ");
  expect(text).not.toMatch(/[\r\n]/);
  expect(o.giveTerminal).toHaveBeenCalledWith("f7");
  expect(o.toFront).toHaveBeenCalledWith("f7");

  const external: TrackedProject = { type: "externe", project: "ext-0123456789abcdef", folder: "/tmp/p", name: "P", client: "c1" };
  await send(external, { ...batch, destination: "mcp", client: "c1" });
  expect(o.prefill).toHaveBeenCalledTimes(1);
});

test("without a main window: a window is reopened and receives the text; if none opens, the send fails (never « ok » with nothing)", async () => {
  const { o, send: send } = mount();
  o.agentWindow.mockReturnValueOnce(undefined as never);
  const reopen = vi.fn();
  const withReopen = createSend({ ...o, reopen: reopen });
  await withReopen({ type: "demo", project: "demo-15283", port: 15283 }, batch);
  expect(reopen).toHaveBeenCalledTimes(1);
  expect(o.prefill).toHaveBeenCalledWith("f7", expect.stringContaining("[remarques de l'utilisateur"));
  o.prefill.mockClear();
  o.agentWindow.mockReturnValue(undefined as never);
  await expect(withReopen({ type: "demo", project: "demo-15283", port: 15283 }, batch)).rejects.toThrow(NO_WINDOW);
  await expect(send({ type: "demo", project: "demo-15283", port: 15283 }, batch)).rejects.toThrow(NO_WINDOW);
  expect(o.prefill).not.toHaveBeenCalled();
});

test("site: preRemplir receives the site app, its folder and the batch path, without \\r or \\n", async () => {
  const { o, send: send } = mount();
  await send({ type: "site", project: "site-tuning", id: "tuning", name: "Tuning" }, { ...batch, project: "site-tuning" });
  expect(o.prefill).toHaveBeenCalledTimes(1);
  const [f, text] = o.prefill.mock.calls[0]!;
  expect(f).toBe("f7");
  expect(text).toContain('appli de site "Tuning" (/workspace/sites/tuning/)');
  expect(text).toContain("/workspace/.webaios/remarques/site-tuning/20261102T101500Z-ab12/lot.json] ");
  expect(text).not.toMatch(/[\r\n]/);
  expect(o.giveTerminal).toHaveBeenCalledWith("f7");
  expect(o.toFront).toHaveBeenCalledWith("f7");
});
