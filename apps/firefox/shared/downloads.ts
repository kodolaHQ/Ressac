/**
 * The pinned downloads whose size the welcome shows: the agents' CLIs (host/agent-cli.ts) and the machine image
 * (host/machine.ts VM_IMAGE). Data only, so that the UI can read it.
 */
export type Agent = "claude" | "codex";

/**
 * The agents' linux-arm64 CLIs (the workshop image carries none): npm's platform packages, one native binary each
 * (`member`, whose file name is `binary`). Claude's is the glibc build the bookworm image needs; Codex's is static (musl).
 * Pinned: every tester runs the same agents, and a new download never picks up a broken or compromised release. A bump
 * changes `version`, so each Mac downloads the new CLI once. `extras`: more members the CLI needs next to its binary, each
 * checked against its own SHA-256 (an install missing one is downloaded again).
 */
export const AGENT_CLIS: Record<
  Agent,
  { version: string; url: string; sha256: string; bytes: number; member: string; binary: string; extras?: readonly { member: string; binary: string; sha256: string }[] }
> = {
  claude: {
    version: "2.1.325",
    url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.325.tgz",
    sha256: "f50a204ede2553b62a801bacab66d6812f4c82adf27b5fadf589ec7219459cef",
    bytes: 170148882,
    member: "package/claude",
    binary: "claude",
  },
  codex: {
    version: "0.169.0",
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-linux-arm64.tgz",
    sha256: "c1555c8ad3913e703d736584ff15e98eaeda685bf6eaedc83ae15943badbc1ff",
    bytes: 171743625,
    member: "package/vendor/aarch64-unknown-linux-musl/bin/codex",
    binary: "codex",
    // Code mode (ChatGPT accounts) runs every tool, Ressac's MCP ones included, through this sibling binary.
    extras: [
      {
        member: "package/vendor/aarch64-unknown-linux-musl/bin/codex-code-mode-host",
        binary: "codex-code-mode-host",
        sha256: "66874c7881c4004f1c155584e1325cad17795bdd91b886995ad8a043809c1019",
      },
    ],
  },
};

/** The machine image's size in bytes (VM_IMAGE.bytes). */
export const VM_IMAGE_BYTES = 530054536;

/** A download size in MB rounded to tens, as the welcome says it (« environ 170 Mo »). */
export const aboutMb = (bytes: number): number => Math.round(bytes / 1e7) * 10;
