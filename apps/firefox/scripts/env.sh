#!/bin/zsh
# Environment for surfer and mach commands: Python >= 3.10, Rust, macOS SDK 26.5, GNU tar.
export PATH="/opt/homebrew/opt/python@3.12/libexec/bin:$HOME/.cargo/bin:$PATH"
# The macOS 27 SDK breaks Mozilla's linker (unknown arm64e.x1 architecture).
export MACOS_SDK_DIR=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
command -v gtar >/dev/null || { echo "GNU tar missing: brew install gnu-tar" >&2; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "Python 3.10+ missing: brew install python@3.12" >&2; exit 1; }
exec "$@"
