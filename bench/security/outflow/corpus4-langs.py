# Dumps corpus4-langs.json: the digit words 0-9 of each language of packages/kernel/scripts/digit-words.py, grouped
# per language (that script merges them into one table). Same sources, same folding, same one-word filter; a digit
# that is no single word in a language is null there (the corpus writes it as a numeral).
# Run from the repo root: uv run --with num2words==0.5.14 python -I bench/security/outflow/corpus4-langs.py
import json
import unicodedata
from pathlib import Path

from num2words import CONVERTER_CLASSES, num2words


def fold(word):
    out = []
    latin = False
    for c in unicodedata.normalize("NFD", word.lower()):
        if c in "'’ʼ":
            continue
        if unicodedata.category(c).startswith("M") and latin:
            continue
        latin = unicodedata.name(c, "").startswith(("LATIN", "GREEK"))
        out.append(c)
    return unicodedata.normalize("NFC", "".join(out))


def one_word(w):
    return len(w) >= 2 and all(unicodedata.category(c)[0] in "LM" for c in w)


# First spelling of the generator's hand tables.
langs = {
    "el": ["μηδέν", "ένα", "δύο", "τρία", "τέσσερα", "πέντε", "έξι", "επτά", "οκτώ", "εννέα"],
    "hi": ["शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ"],
}
for lang in sorted(CONVERTER_CLASSES):
    row = []
    for digit in range(10):
        try:
            w = num2words(digit, lang=lang)
        except Exception:
            w = None
        # Written as the language writes it (accents kept); the table holds its folded form.
        row.append(w if w is not None and one_word(fold(w)) else None)
    if any(row):
        langs[lang] = row
Path(__file__).resolve().parent.joinpath("corpus4-langs.json").write_text(json.dumps(langs, ensure_ascii=False, indent=1) + "\n")
