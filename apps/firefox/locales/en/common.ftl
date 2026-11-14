# Shared by several screens.

# Used by the i18n tests: a plural.
test-plural = { $count ->
    [one] { $count } tab
   *[other] { $count } tabs
}
# Used by the i18n tests: only in English, so other languages fall back to it.
test-english-only = Only in English
