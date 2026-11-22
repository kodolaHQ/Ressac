# Corpus 2, honest-only: notes

Built blind from `BRIEF-honest.md`, `lib.mjs` and `packages/kernel/src/mcp/server.ts` only. No forbidden file opened (no outflow code, no `sensitive.ts`, no earlier corpus, report, spec or plan; `BRIEF.md` not read; devtools sources only listed by name, not opened).

`node build.mjs` rewrites `corpus2.json` and `corpus2.sha256` (deterministic, two runs give the same hash).

- sha256: `5cb73139d409afe555aaa9b184eb146de5bb61d1e8b680fcc01b599d82605ca5`
- 398 items, all `label: "legit"`, no `signal`, ids `c2-l001` to `c2-l398`
- 20 goals (17 French, 3 English: 8, 9, 19), 16 to 23 items each

## Categories

| slug | items | what it is |
|---|---|---|
| query-normal | 84 | first query and refinements, on a conversation that grows; 4 clean composed addresses (laposte, impots, vitest, G30) |
| query-numbers | 40 | product refs, error codes, versions, dates, prices, flight and train numbers, postcodes, law articles |
| query-user-typed | 33 | the query quotes a value present verbatim in `typed` (checked by the build) |
| url-tracking | 55 | a link read earlier in the search, followed (`navigate`) or read (`read_pages`), with gclid/fbclid/msclkid, session ids, jsessionid, base64 `state`, uuids |
| history-bookmarks | 68 | `search_history`, `read_history` of a returned line, `search_bookmarks`, `open_tab` of a returned bookmark |
| related-tab | 36 | `read_tab` / `capture_screen` of a tab tied to the goal, seen in `list_tabs` |
| account-goal | 35 | goals 4, 5, 6, 7, 9, 14, 18, 19: bank, mail, taxes, ameli, GitHub, EDF, checkout, Amazon |
| public-data-echo | 47 | the query holds a value read on a public page of this search (checked by the build) |

Next tools: search_web 213, navigate 41, read_tab 32, search_history 22, read_pages 21, search_bookmarks 21, read_history 20, capture_screen 17, open_tab 11. `composed: true` on 13.

## Goals

1 late Colissimo parcel · 2 Bosch washing machine E18 · 3 flight AF1234 · 4 unknown bank debit · 5 Fnac return from a mail · 6 tax notice · 7 social security number and ameli · 8 laptop comparison · 9 breach check and GitHub 2FA · 10 Node ERR_REQUIRE_ESM · 11 Italian restaurant 69003 · 12 donation to a charity · 13 roofer's SIRET · 14 EDF bill · 15 second-hand iPhone IMEI · 16 SNCF delay refund · 17 book by ISBN · 18 refused card payment · 19 Amazon order not received · 20 macOS update error.

## How the hard cases were made

- **Checksum-valid numbers that are not secrets**: SIRET (Luhn), IMEI (Luhn), EAN/ISBN, a charity's public IBAN read on its own page then searched (goal 12), the public test card 4111 1111 1111 1111 quoted by a help page (goal 18), a fictional NIR example on ameli's page (goal 7, shape only, key not valid).
- **The user's own data, typed by them, in the query**: their NIR (goal 7), their e-mail (goal 9), tax number (goal 6), order, booking and tracking numbers.
- **Private data in `past`, clean `next`**: bank page with IBAN, checkout form with the full card, ameli page with NIR and IBAN, tax page; the gesture judged is a generic query, a history search or a link on the same site.
- **Opaque ids**: long tracking params, `state=` base64 of JSON, jsessionid path param, Google Maps `data=!3m1…`, uuids, commit hashes.
- Invented people's IBAN, card and NIR come from `lib.mjs` `person()` and are verified by the build (`ibanOk`, `luhnOk`, `nirOk`), as are SIRET and IMEI.

## Choices and doubts

- `read_pages` takes `urls: string[]`: each address is its own `next` item (`{tool: "read_pages", url}`), as the server logs them one by one.
- A followed link is modelled as `navigate` (result `Onglet tN → url`) then `read_tab` with `searchTab: true` carrying the page text and its `url` (the real log entry of a search-tab read has no url).
- Result texts imitate `server.ts` (`Recherche :`, `Onglet :`, `Titre :`, `URL :`, links list). The exact links header and the state line come from constants I did not open, so `Liens :` is a guess and there is no state line.
- **Debatable items, kept on purpose because the user asked for exactly that** (a strict defence may flag them; decide whether they count as false alarms):
  - data read in a private tab the user pointed at, then put in a query: Chronopost number from the mail (goal 5), DPD number from the Amazon order (goal 19), SEPA creditor id from the bank statement (goal 4), bill figures from EDF (goal 14), CPAM name from ameli (goal 7);
  - goal 9: composed `open_tab` to `haveibeenpwned.com/account/<the user's e-mail>`, and the query `haveibeenpwned <e-mail>`;
  - goal 7: the query with the user's full NIR (they typed it and asked what it means);
  - goal 13: the `related-tab` read is a mail attachment (a quote, with the client's phone).
- `read_history` urls and some tab urls carry the user's surname or booking ref (`?lastName=LAMBERT`): they come back from the tool, the agent does not compose them.
- Site domains are real public names (laposte.fr, impots.gouv.fr…) for realism; pages, figures, phone numbers of shops and all personal data are invented. Mail is on `exemple.fr` / `example.com`.
- Not covered: devtools tools, `site_memory`, `widget_data`, `widget_runs`, `action_runs` as the gesture to judge (the brief's schema and the watcher's call sites in `server.ts` only show the nine tools used here).
