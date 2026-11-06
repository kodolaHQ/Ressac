import net from "node:net";

/** A Marionette frame: `<length in bytes>:<json>`. */
export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`${json.length}:`, "ascii"), json]);
}

/** The complete messages in `buffer`, and the start of a frame that has not fully arrived yet. */
export function decodeFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let i = 0;
  for (;;) {
    const colon = buffer.indexOf(0x3a, i);
    if (colon < 0) break;
    const length = Number(buffer.subarray(i, colon).toString("ascii"));
    const end = colon + 1 + length;
    if (end > buffer.length) break;
    messages.push(JSON.parse(buffer.subarray(colon + 1, end).toString("utf8")));
    i = end;
  }
  return { messages, rest: buffer.subarray(i) };
}

type Response = [1, number, { error: string; message: string } | null, unknown];

/** Minimal client for Firefox's Marionette protocol (version 3). */
export class Marionette {
  private id = 0;
  private rest: Buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(
    private readonly socket: net.Socket,
    onHello: (m: unknown) => void,
  ) {
    let first = true;
    socket.on("data", (chunk: Buffer) => {
      const { messages, rest } = decodeFrames(Buffer.concat([this.rest, chunk]));
      this.rest = rest;
      for (const m of messages) {
        if (first) {
          first = false;
          onHello(m);
          continue;
        }
        const [, id, error, result] = m as Response;
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (error) p?.reject(new Error(`${error.error}: ${error.message}`));
        else p?.resolve(result);
      }
    });
    socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("Marionette: connection closed"));
      this.pending.clear();
    });
  }

  static connect(port: number): Promise<Marionette> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("error", reject);
      // The server speaks first: {"applicationType":"gecko","marionetteProtocol":3}.
      const m: Marionette = new Marionette(socket, () => resolve(m));
    });
  }

  command<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    // Firefox already gone (a test quit it): nothing would ever answer.
    if (this.socket.destroyed) return Promise.reject(new Error("Marionette: connection closed"));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(encodeFrame([0, id, name, params]));
    });
  }

  async setContext(context: "chrome" | "content"): Promise<void> {
    await this.command("Marionette:SetContext", { value: context });
  }

  async execute<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    return (await this.command<{ value: T }>("WebDriver:ExecuteScript", { script, args })).value;
  }

  close(): void {
    this.socket.destroy();
  }
}
