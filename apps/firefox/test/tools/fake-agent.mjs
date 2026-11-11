// Fake interactive agent launched by the fake docker: notes what it receives in WEBAIOS_ROOT.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.WEBAIOS_ROOT;
writeFileSync(join(root, "fake-agent-args.json"), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(root, "fake-agent-pid"), String(process.pid));
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
    if (line === "quit") process.exit(0);
    // What Claude Code sends when its own (mouse) selection is copied: OSC 52 with the text in base64.
    if (line === "osc52") process.stdout.write(`\x1b]52;c;${Buffer.from("copié par l'agent ✓").toString("base64")}\x07`);
    if (line === "flood") process.stdout.write("x".repeat(80).concat("\r\n").repeat(13_000));
    line = "";
    invite();
  }
});
