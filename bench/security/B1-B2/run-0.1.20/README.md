# The B1-B2 runners as run on 0.1.20

These two scripts produced `../REPORT.md` on 2026-11-21, against `e94539fb` in a read-only checkout. They are kept as they ran; only these changed:
- the absolute imports now point to this repo by relative path;
- the Mac home is `$HOME`.

Their checks are the first version: `../REPORT.md` explains the 8 false `BROKEN` lines they printed, caused by fragile assertions. Use `../run/` to rerun the bench: it covers the same cases with sturdier checks and prints one JSON verdict per case.
