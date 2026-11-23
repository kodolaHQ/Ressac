# Domain checks and renames

Every invented domain of B3 was looked up on 2026-11-22 with `dig` (NS, A, SOA status) and `whois`. A domain that resolves or is registered may belong to a real business, so it is renamed to an unregistered look-alike on the same TLD (no `.example`: the agent should not see a test).

## The ressac set (`cases.json`)

All 35 distinct `attacker_domain` values return NXDOMAIN and no whois record. **No rename**: `cases.json`, `cases.json.sha256` and `generate-log.jsonl` are as the generator wrote them.

## The encoded-lang set (`cases-lang.json`)

Of the 10 `attacker_domain` values, 9 return NXDOMAIN and no whois record. `comparatif-robot.fr` (`encoded-lang-8`) resolves and is registered (AFNIC, ACTIVE): it became `comparatif-robots-aspirants.fr` (NXDOMAIN, no record) everywhere in both arms, before the sha256 was written. `generate-log.jsonl` keeps the model's raw reply with the old name.

## The persona (`harness.mts`)

| Was | Found | Now |
|---|---|---|
| `novimmo.fr` (history entry, bank operation « LOYER NOVIMMO ») | resolves, registered (OVH) | `novimmolia.fr`, « LOYER NOVIMMOLIA » |
| `cabinet-marceau.fr` (the doctor's e-mail) | resolves, registered (Scaleway) | `cabinet-dr-marceau.fr`; the `doctor` canary form follows |

Unregistered, unchanged: `novacourriel.fr`, `banque-ardoise.fr`, `labo-bellecour.fr`, `colis-rapide.fr`, `guide-electromenager.fr`, `mutuelle-rhodanienne.fr`, `lumen-maison.fr`, `cherchetout.fr`, and the wiring test's `guide-menager-exemple.fr`, `suivi-exemple.fr`, `exemple-tiers.fr`, `cuisine-exemple-test.fr`, `annuaire-recettes-exemple.fr`, `box-exemple-test.fr`.

Not checked: the other hosts the generated pages link to (public sites the cover pages cite, as a real page would).

## Profile b (`profiles.mjs`, the differential test)

Checked on 2026-11-23 with `dig` and `whois`: `cabinet-dr-vasseur.fr` (the doctor's e-mail domain, the one new domain of profile b) returns NXDOMAIN and no whois record. Every other domain of profile b is profile a's.
