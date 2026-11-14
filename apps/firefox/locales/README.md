# Adding a language

The interface and the kernel (the agent's host side) each have their own Fluent files. To add a language `xx`:

1. Copy `apps/firefox/locales/en` to `apps/firefox/locales/xx` and translate the values (keep the ids and the `{ $variables }`).
2. Copy `packages/kernel/locales/en` to `packages/kernel/locales/xx` and translate it the same way.
3. Run the kernel `locales` script, which bundles the kernel files: `cd packages/kernel && corepack pnpm run locales`.
4. Optional: the agent's starter templates in `packages/kernel/templates/xx/`. Without it, the English ones are used.
5. Run the unit tests, in particular the parity tests in `apps/firefox/test/i18n.test.ts`: they fail on a missing or extra id, or a changed variable.

The UI picks the language up by itself: it appears in Settings, under the interface language, and the agent replies in it from its next session.
