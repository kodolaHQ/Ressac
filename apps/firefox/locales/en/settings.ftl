# The Settings page.

settings-title = Settings
settings-nav-label = Settings sections
settings-section-agents = Agents
settings-ai-switch = AI features
settings-ai-switch-note = The agent, local AI and widgets. Off, Ressac starts neither Docker nor Ollama.
settings-section-ai = Local AI
settings-section-workshop = Container
settings-section-permissions = Permissions
settings-section-data = Data
settings-section-privacy = Privacy
settings-section-shortcuts = Shortcuts
settings-section-about = About

settings-checking = Checking…
settings-error = Error: { $error }
settings-agent-silent = The agent is not responding
settings-agent-silent-sentence = The agent is not responding.

settings-agent-logged-in-account = Signed in ({ $account })
settings-agent-logged-in = Signed in
settings-agent-logged-out = Not signed in
settings-agent-docker-absent = Docker is not running: see Container.
settings-agent-no-container = The agent's workshop is not started: see Container.
settings-agent-device-code = Open the sign-in page and enter the code
settings-agent-device-waiting = Waiting for sign-in…
settings-agent-panel-login = Claude Code asks you to sign in in the agent panel; otherwise, type /login.
settings-agent-codex-login = Sign in with your ChatGPT subscription: a code to enter on OpenAI's site.
settings-agent-open-chats = Conversations that are already open keep going until they restart.
settings-agent-device-open = Open the sign-in page
settings-agent-login = Sign in
settings-agent-logout = Sign out

settings-ai-intro = A small AI runs on your Mac, alongside the agent: it pauses the agent when one of its actions looks odd, sorts what Ressac follows for you and writes the summaries. It is free and nothing it reads leaves your machine. It needs Ollama, the open source software that runs it, and two models.
settings-ai-ollama-outdated = version { $version }, { $min } is required
settings-ai-ollama-update = Update Ollama
settings-ai-ollama-stopped = stopped
settings-ai-ollama-starting = Starting…
settings-ai-ollama-start = Start
settings-ai-ollama-download = Download Ollama (190 MB)
settings-ai-ollama-reachable = reachable
settings-ai-ollama-unreachable = unreachable
settings-ai-gemma-present = Widgets and watch: Gemma ({ $model })
settings-ai-gemma-absent = Widgets and watch: Gemma missing
settings-ai-decision-model = Decision model
settings-ai-large-download = Several GB: the download may take a while.

settings-pill-installed = installed
settings-pill-absent = missing
settings-pull-download = Download
settings-pull-progress-unknown = Downloading…
settings-pull-progress = Downloading { $percent }%

settings-workshop-name = Agent workshop
settings-workshop-started = Workshop started
settings-workshop-stopped = Workshop stopped
settings-workshop-absent = Workshop not created yet: it is built the first time the agent opens.
settings-workshop-docker-absent = Docker (OrbStack) is not running or not installed.
settings-workshop-restarting = Restarting…
settings-workshop-rebuilding = Rebuilding… (a few minutes)
settings-workshop-confirm-restart = Running agents and apps stop, then the agents start again.
settings-workshop-confirm-rebuild = Rebuilding reinstalls Claude Code and Codex and takes a few minutes. Running agents and apps stop; your projects and the Claude and Codex sign-ins stay.
settings-docker-start = Start { $app }
settings-docker-install = Install OrbStack
settings-restart = Restart
settings-rebuild = Rebuild
settings-cancel = Cancel

settings-telemetry-label = Send crashes and errors
settings-telemetry-unavailable = This version sends nothing.

settings-interface = Interface
settings-language-label = Language
settings-language-system-named = Mac language ({ $name })
settings-language-system = Mac language
settings-language-agent-note = The agent will speak { $language } from its next session.
settings-engine-label = Search engine
settings-engine-help = The agent searches with this engine too. An engine that asks for an account may get in its way.
settings-engine-other = Other…
settings-engine-custom-label = Search address
settings-hints-label = Tips
settings-hints-help = Advice on the home page and the first time you open the agent, design mode and actions.
settings-start-home-label = Open on the home page
settings-start-home-help = At launch, each window shows the home page instead of the last tab seen. Tabs stay open.
settings-default-browser-label = Default browser
settings-default-browser-help = Links from other apps open in Ressac.
settings-default-browser-is = Default
settings-default-browser-set = Make default
settings-appearance-label = Appearance
settings-appearance-system = Like the Mac
settings-appearance-light = Light
settings-appearance-dark = Dark
settings-sidebar-label = Navigation bar
settings-sidebar-left = On the left
settings-sidebar-right = On the right

settings-about-release-notes = What's new
settings-about-replay-welcome = Replay the welcome
settings-about-advanced = Advanced browser settings
settings-about-update-check = Check for updates
settings-about-update-restart = Restart now
settings-about-update-download = Download the latest version
settings-credits = Credits
settings-credits-built-on-before = Ressac is built on
settings-credits-built-on-after = by Mozilla and shares its license, the MPL 2.0.
settings-credits-licenses-before = It bundles Node.js and node-pty (MIT license) and the Geist and Funnel Display fonts (OFL license). Local AI runs through Ollama (MIT), with Google's Gemma 4 models and Perplexity's pplx-decider-flash (Apache 2.0), downloaded on demand. Agents use Claude Code or Codex with your own account. The full licenses are in the app, in the folder
