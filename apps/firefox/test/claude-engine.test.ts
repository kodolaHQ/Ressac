import { describe, expect, it } from "vitest";
import { claudeEngineEnv, withoutV1 } from "../host/claude-engine";
import { DEFAULT_CLAUDE_ENGINE, type ClaudeEngine } from "../shared/settings";

const e = (o: Partial<ClaudeEngine>): ClaudeEngine => ({ ...DEFAULT_CLAUDE_ENGINE, ...o });
const models = (m: string) => ({
  ANTHROPIC_MODEL: m,
  ANTHROPIC_DEFAULT_OPUS_MODEL: m,
  ANTHROPIC_DEFAULT_SONNET_MODEL: m,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
  ANTHROPIC_DEFAULT_FABLE_MODEL: m,
  CLAUDE_CODE_SUBAGENT_MODEL: m,
});

describe("claudeEngineEnv", () => {
  it("subscription", () => {
    expect(claudeEngineEnv(e({}), null)).toEqual({ args: [], env: {} });
  });
  it("ollama", () => {
    expect(claudeEngineEnv(e({ kind: "ollama", ollamaUrl: "http://host.docker.internal:11434/", ollamaModel: "m" }), null)).toEqual({
      args: [],
      env: { ANTHROPIC_BASE_URL: "http://host.docker.internal:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ...models("m") },
    });
  });
  it("a trailing /v1 is dropped, localhost becomes the container alias", () => {
    const base = (ollamaUrl: string) => claudeEngineEnv(e({ kind: "ollama", ollamaUrl, ollamaModel: "m" }), null).env.ANTHROPIC_BASE_URL;
    expect(base("http://host.docker.internal:11434/v1/")).toBe("http://host.docker.internal:11434");
    expect(base("http://localhost:11434/v1")).toBe("http://host.docker.internal:11434");
    expect(base("http://127.0.0.1:11434/proxy")).toBe("http://host.docker.internal:11434/proxy");
    expect(withoutV1("https://api.example/v1")).toBe("https://api.example");
    expect(withoutV1("https://api.example/v10")).toBe("https://api.example/v10");
  });
  it("ollama without a model", () => {
    expect(() => claudeEngineEnv(e({ kind: "ollama", ollamaModel: "" }), null)).toThrow("Réglez l'adresse et le modèle d'Ollama dans Réglages › Agents.");
  });
  it("api", () => {
    const api = e({ kind: "api", apiUrl: "https://x.test", apiModel: "m1" });
    expect(() => claudeEngineEnv(api, null)).toThrow("Aucune clé enregistrée pour l'API compatible (Réglages › Agents).");
    expect(claudeEngineEnv(api, { url: "http://host.docker.internal:5555", token: "t" })).toEqual({
      args: [],
      env: { ANTHROPIC_BASE_URL: "http://host.docker.internal:5555", ANTHROPIC_AUTH_TOKEN: "t", ...models("m1") },
    });
  });
  it("api: a bad address names the problem", () => {
    expect(() => claudeEngineEnv(e({ kind: "api", apiUrl: "http://example.com", apiModel: "m" }), { url: "http://h:1", token: "t" })).toThrow("Adresse invalide (https://…) (Réglages › Agents)");
  });
});
