import { expect, test } from "vitest";
import { isSensitive } from "../../src/access/sensitive.js";

test.each([
  "https://mail.google.com/mail/u/0/#inbox",
  "https://outlook.live.com/mail/",
  "https://mail.proton.me/u/0/inbox",
  "https://clients.boursobank.com/compte/cav/x/mouvements",
  "https://www.labanquepostale.fr/particuliers",
  "https://particuliers.societegenerale.fr/x",
  "https://app.qonto.com/organizations",
  "https://www.paypal.com/myaccount/summary",
  "https://app.payfit.com/payslips",
  "https://my.1password.com/",
  "https://vault.bitwarden.com/",
  "https://console.aws.amazon.com/",
  "https://github.com/settings/tokens",
  "https://myaccount.google.com/apppasswords",
  "about:logins",
  "about:preferences#privacy",
  "https://www.ameli.fr/assure/compte",
  "https://www.impots.gouv.fr/accueil/espace-particulier",
  "https://MAIL.GOOGLE.COM/",
])("sensitive: %s", (url) => expect(isSensitive(url)).toBe(true));

test.each([
  "https://github.com/sveltejs/svelte/issues/1",
  "https://www.marmiton.org/recettes/x",
  "https://www.youtube.com/watch?v=x",
  "https://www.boursorama.com/cours/1rPAIR/",
  "https://docs.stripe.com/billing",
  "https://example.com/accounting-tips",
  "https://example.com/docs/billing",
  "not a url",
  "",
])("not sensitive: %s", (url) => expect(isSensitive(url)).toBe(false));
