import { describe, expect, it } from "vitest";
import { codexEngineArgs } from "../host/codex-engine";
import { apiUrlProblem, CodexEngineSchema, DEFAULT_CODEX_ENGINE, type CodexEngine } from "../shared/settings";

const e = (o: Partial<CodexEngine>): CodexEngine => ({ ...DEFAULT_CODEX_ENGINE, ...o });

describe("codexEngineArgs", () => {
  it("chatgpt", () => {
    expect(codexEngineArgs(e({}), null)).toEqual({ args: [], env: {} });
  });
  it("ollama", () => {
    expect(codexEngineArgs(e({ kind: "ollama", ollamaUrl: "http://127.0.0.1:11434/" }), { url: "http://host.docker.internal:5555", token: "t" })).toEqual({
      args: [
        "-c", 'model_provider="ressac-ollama"',
        "-c", 'model_providers.ressac-ollama={name="Ollama",base_url="http://host.docker.internal:5555",env_key="RESSAC_ENGINE_TOKEN"}',
        "-m", "gpt-oss:20b",
      ],
      env: { RESSAC_ENGINE_TOKEN: "t" },
    });
  });
  it("ollama needs the relay", () => {
    expect(() => codexEngineArgs(e({ kind: "ollama", ollamaUrl: "http://127.0.0.1:11434/" }), null)).toThrow("Réglez");
  });
  it("api", () => {
    expect(codexEngineArgs(e({ kind: "api", apiUrl: "https://x.test/v1", apiModel: "m1" }), { url: "http://host.docker.internal:5555", token: "t" })).toEqual({
      args: [
        "-c", 'model_provider="ressac-api"',
        "-c", 'model_providers.ressac-api={name="API compatible",base_url="http://host.docker.internal:5555",env_key="RESSAC_ENGINE_TOKEN"}',
        "-m", "m1",
      ],
      env: { RESSAC_ENGINE_TOKEN: "t" },
    });
  });
  it("api: a bad address names the problem", () => {
    expect(() => codexEngineArgs(e({ kind: "api", apiUrl: "http://example.com", apiModel: "m" }), { url: "http://h:1", token: "t" })).toThrow("Adresse invalide (https://…) (Réglages › Agent)");
  });
  it("quotes", () => {
    const v = codexEngineArgs(e({ kind: "ollama", ollamaUrl: "http://h/" }), { url: "http://h/a\"b", token: "t" }).args[3]!;
    expect(v).toContain("%22");
    expect(v.replace(/\\"/g, "").match(/"/g)!.length % 2).toBe(0);
    expect(v).toContain('base_url="http://h/a%22b"');
  });
  it("incomplete", () => {
    expect(() => codexEngineArgs(e({ kind: "api", apiUrl: "https://x.test", apiModel: "" }), { url: "http://h:1", token: "t" })).toThrow(
      "Réglez l'adresse et le modèle de l'API compatible dans Réglages › Agent.",
    );
    expect(() => codexEngineArgs(e({ kind: "api", apiUrl: "https://x.test", apiModel: "m" }), null)).toThrow("Aucune clé enregistrée pour l'API compatible (Réglages › Agent).");
    expect(() => codexEngineArgs(e({ kind: "ollama", ollamaModel: "" }), null)).toThrow("Réglez l'adresse et le modèle d'Ollama dans Réglages › Agent.");
  });
  it("refuses a model that looks like a flag", () => {
    expect(() => codexEngineArgs(e({ kind: "ollama", ollamaModel: "--foo" }), null)).toThrow("Réglez");
    expect(CodexEngineSchema.safeParse(e({ apiModel: "-x" })).success).toBe(false);
  });
  it("apiUrlProblem", () => {
    expect(apiUrlProblem("https://openrouter.ai/api/v1")).toBeNull();
    expect(apiUrlProblem("http://127.0.0.1:1234/v1")).toBeNull();
    for (const u of ["https://x.test/v1?a=b", "https://x.test/v1#f"]) expect(apiUrlProblem(u)).toBe("Adresse invalide (https://…)");
    for (const u of ["http://example.com", "ftp://x", "pas une url"]) expect(apiUrlProblem(u)).toBe("Adresse invalide (https://…)");
  });
});
