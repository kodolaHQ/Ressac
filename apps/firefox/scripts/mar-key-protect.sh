#!/bin/zsh
# Stores the MAR signing key's password again with an empty access list, so macOS asks before every read
# (package.sh then shows a keychain prompt). Created by plain `security add-generic-password`, the item trusts
# /usr/bin/security, so any process of the session could read it silently. Run once on the machine that packages.
set -euo pipefail
service=ressac-mar-signing

pw=$(security find-generic-password -s $service -a ressac -w) || { print -u2 "no keychain item $service"; exit 1 }
# -U replaces the item; -T "" trusts no application, so every read prompts.
security add-generic-password -U -s $service -a ressac -w "$pw" -T ""
unset pw
print "Done: reading $service now asks for your permission (package.sh will prompt once per run)."
