// Fake interactive agent launched by the fake docker: notes what it receives in RESSAC_ROOT.
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RESSAC_ROOT;
// Written whole (temp file, then rename): tests poll these files and must never read half of one.
const put = (f, v) => (writeFileSync(`${f}.tmp`, v), renameSync(`${f}.tmp`, f));
put(join(root, "fake-agent-args.json"), JSON.stringify(process.argv.slice(2)));
put(join(root, "fake-agent-pid"), String(process.pid));
const invite = () => process.stdout.write("fake agent ready> ");
invite();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let line = "";
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  appendFileSync(join(root, "fake-agent-input.txt"), text);
  for (const c of text) {
    if (c !== "\r") {
      line += c;
      process.stdout.write(c);
      continue;
    }
    process.stdout.write(`\r\nreceived: ${line}\r\n`);
    // The panel opened on a web tab pre-fills its context (« [contexte : … ] »): `quit` after it still quits.
    if (line.replace(/^(\[contexte : [^\]]*\] )+/, "") === "quit") process.exit(0);
    // What Claude Code sends when its own (mouse) selection is copied: OSC 52 with the text in base64.
    if (line === "osc52") process.stdout.write(`\x1b]52;c;${Buffer.from("copié par l'agent ✓").toString("base64")}\x07`);
    // A hyperlink (OSC 8) as Claude Code prints its sign-in address; long enough to fill its first row.
    if (line === "link") process.stdout.write(`\x1b]8;;https://sign-in.invalid/oauth?code=1\x07${"sign-in-link ".repeat(20)}\x1b]8;;\x07\r\n`);
    if (line === "flood") process.stdout.write("x".repeat(80).concat("\r\n").repeat(13_000));
    line = "";
    invite();
  }
});
