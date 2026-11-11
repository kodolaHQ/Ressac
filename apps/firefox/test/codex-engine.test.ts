import { describe, expect, it } from "vitest";
import { codexEngineArgs } from "../host/codex-engine";
import { apiUrlProblem, CodexEngineSchema, DEFAULT_CODEX_ENGINE, type CodexEngine } from "../shared/settings";

const e = (o: Partial<CodexEngine>): CodexEngine => ({ ...DEFAULT_CODEX_ENGINE, ...o });

describe("codexEngineArgs", () => {
  it("chatgpt", () => {
    expect(codexEngineArgs(e({}), null)).toEqual({ args: [], env: {} });
  });
  it("ollama", () => {
    expect(codexEngineArgs(e({ kind: "ollama", ollamaUrl: "http://host.docker.internal:11434/" }), null)).toEqual({
      args: [
        "-c", 'model_provider="webaios-ollama"',
        "-c", 'model_providers.webaios-ollama={name="Ollama",base_url="http://host.docker.internal:11434/v1",env_key="WEBAIOS_ENGINE_TOKEN"}',
        "-m", "gpt-oss:20b",
      ],
      env: { WEBAIOS_ENGINE_TOKEN: "ollama" },
    });
  });
  it("api", () => {
    expect(codexEngineArgs(e({ kind: "api", apiUrl: "https://x.test/v1", apiModel: "m1" }), { url: "http://host.docker.internal:5555", token: "t" })).toEqual({
      args: [
        "-c", 'model_provider="webaios-api"',
        "-c", 'model_providers.webaios-api={name="API compatible",base_url="http://host.docker.internal:5555",env_key="WEBAIOS_ENGINE_TOKEN"}',
        "-m", "m1",
      ],
      env: { WEBAIOS_ENGINE_TOKEN: "t" },
    });
  });
  it("api: a bad address names the problem", () => {
    expect(() => codexEngineArgs(e({ kind: "api", apiUrl: "http://example.com", apiModel: "m" }), { url: "http://h:1", token: "t" })).toThrow("Adresse invalide (https://…) (Réglages › Agents)");
  });
  it("quotes", () => {
    const v = codexEngineArgs(e({ kind: "ollama", ollamaUrl: "http://h/a\"b" }), null).args[3]!;
    expect(v).toContain("%22");
    expect(v.replace(/\\"/g, "").match(/"/g)!.length % 2).toBe(0);
    expect(v).toContain('base_url="http://h/a%22b/v1"');
  });
  it("incomplete", () => {
    expect(() => codexEngineArgs(e({ kind: "api", apiUrl: "https://x.test", apiModel: "" }), { url: "http://h:1", token: "t" })).toThrow(
      "Réglez l'adresse et le modèle de l'API compatible dans Réglages › Agents.",
    );
    expect(() => codexEngineArgs(e({ kind: "api", apiUrl: "https://x.test", apiModel: "m" }), null)).toThrow("Aucune clé enregistrée pour l'API compatible (Réglages › Agents).");
    expect(() => codexEngineArgs(e({ kind: "ollama", ollamaModel: "" }), null)).toThrow("Réglez l'adresse et le modèle d'Ollama dans Réglages › Agents.");
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
