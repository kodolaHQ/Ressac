# Texts the kernel shows the user: watch notifications, workshop build steps, applications, local AI install.

kernel-new-items = { $n ->
    [one] { $n } new item
   *[other] { $n } new items
}

kernel-build-base-image = Downloading the base image
kernel-build-system-tools = System tools
kernel-build-claude-codex = Installing Claude Code and Codex
kernel-build-preparing = Preparing
kernel-container-start-failed = Container { $name } could not start: { $error }

kernel-app-docker-not-running = Docker is not running.
kernel-app-no-port = No free port left: stop an application.
kernel-app-not-responding = The application does not answer on port { $port } after { $seconds } s.
kernel-app-exit-code = Stopped with code { $code }
kernel-app-exit-unknown = Stopped with an unknown code

kernel-ai-install-cancelled = Installation cancelled
kernel-ai-install-running = Installation already in progress
kernel-ai-install-uv = install uv: brew install uv
kernel-ai-git-clone-failed = git clone failed: { $error }
kernel-ai-commit-mismatch = Kev's commit is not the expected one ({ $expected }): { $found }
kernel-ai-uv-sync-failed = uv sync failed: { $error }
kernel-ai-pull-failed = ollama pull failed: { $error }
