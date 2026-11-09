// Fake interactive agent launched by the fake docker: notes what it receives in WEBAIOS_RACINE.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const racine = process.env.WEBAIOS_RACINE;
writeFileSync(join(racine, "faux-agent-args.json"), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(racine, "faux-agent-pid"), String(process.pid));
const invite = () => process.stdout.write("faux agent prêt> ");
invite();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let ligne = "";
process.stdin.on("data", (morceau) => {
  const texte = morceau.toString("utf8");
  appendFileSync(join(racine, "faux-agent-entree.txt"), texte);
  for (const c of texte) {
    if (c !== "\r") {
      ligne += c;
      process.stdout.write(c);
      continue;
    }
    process.stdout.write(`\r\nreçu: ${ligne}\r\n`);
    if (ligne === "quitter") process.exit(0);
    if (ligne === "inonder") process.stdout.write("x".repeat(80).concat("\r\n").repeat(13_000));
    ligne = "";
    invite();
  }
});
