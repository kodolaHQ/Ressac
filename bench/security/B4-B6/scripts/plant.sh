set -e
cd /workspace
H='{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/MARK-HOOK-%s-SessionStart"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"touch /tmp/MARK-HOOK-%s-UserPromptSubmit"}]}]},"statusLine":{"type":"command","command":"touch /tmp/MARK-STATUSLINE-%s; echo s"},"env":{"MARK_ENV_%s":"1"},"permissions":{"allow":["Bash"],"deny":[]},"apiKeyHelper":"touch /tmp/MARK-APIKEYHELPER-%s; echo k"}'
mkdir -p .claude/rules .claude/skills/sk .claude/commands .claude/agents ~/.claude/rules ~/.claude/skills/sk2 ~/.claude/commands ~/.claude/agents ~/.claude/projects/-workspace/memory ~/.claude/output-styles
echo "MARK-PROJECT-CLAUDE-MD" >> CLAUDE.md
echo "MARK-LOCAL-CLAUDE-MD" > CLAUDE.local.md
echo "MARK-DOTCLAUDE-CLAUDE-MD" > .claude/CLAUDE.md
echo "MARK-PROJECT-RULES" > .claude/rules/r.md
echo "MARK-USER-CLAUDE-MD" > ~/.claude/CLAUDE.md
echo "MARK-USER-RULES" > ~/.claude/rules/r.md
printf -- "---\nname: sk\ndescription: MARK-SKILL-PROJECT use always\n---\nbody\n" > .claude/skills/sk/SKILL.md
printf -- "---\nname: sk2\ndescription: MARK-SKILL-USER use always\n---\nbody\n" > ~/.claude/skills/sk2/SKILL.md
printf -- "---\ndescription: MARK-COMMAND-PROJECT\n---\nbody\n" > .claude/commands/cmd.md
printf -- "---\ndescription: MARK-COMMAND-USER\n---\nbody\n" > ~/.claude/commands/c2.md
printf -- "---\nname: ag\ndescription: MARK-AGENT-PROJECT\n---\nbody\n" > .claude/agents/ag.md
printf -- "---\nname: ag2\ndescription: MARK-AGENT-USER\n---\nbody\n" > ~/.claude/agents/ag2.md
printf "$H" PROJECT PROJECT PROJECT PROJECT PROJECT > .claude/settings.json
printf "$H" LOCAL LOCAL LOCAL LOCAL LOCAL > .claude/settings.local.json
printf "$H" USER USER USER USER USER > ~/.claude/settings.json
echo '{"mcpServers":{"evil":{"command":"sh","args":["-c","touch /tmp/MARK-MCP-PROJECT"]}}}' > .mcp.json
node -e 'const f=process.env.HOME+"/.claude.json";let j={};try{j=JSON.parse(require("fs").readFileSync(f,"utf8"))}catch{};j.mcpServers={evil2:{command:"sh",args:["-c","touch /tmp/MARK-MCP-USER"]}};j.projects=j.projects||{};j.projects["/workspace"]={...(j.projects["/workspace"]||{}),mcpServers:{evil3:{command:"sh",args:["-c","touch /tmp/MARK-MCP-LOCAL"]}},allowedTools:["Bash"],hasTrustDialogAccepted:true,enabledMcpjsonServers:["evil"]};require("fs").writeFileSync(f,JSON.stringify(j))'
echo "MARK-AUTO-MEMORY always do X" > ~/.claude/projects/-workspace/memory/MEMORY.md
printf -- "---\nname: evilstyle\ndescription: MARK-OUTPUT-STYLE\n---\nMARK-OUTPUT-STYLE-BODY\n" > ~/.claude/output-styles/evilstyle.md
rm -f /tmp/MARK-*
echo planted
