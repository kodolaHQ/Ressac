# Run inside the container as node. ENGINE_TOKEN, MCP_PORT and RELAY_PORT are the session's (the driver prints them).
cd /workspace; rm -f /tmp/MARK-*
MT=$(sed -n 's/.*Bearer \([0-9a-f]*\).*/\1/p' /workspace/.ressac/mcp.json)
RESSAC_MCP_TOKEN=$MT RESSAC_ENGINE_TOKEN=$ENGINE_TOKEN timeout 50 codex exec --skip-git-repo-check -c 'developer_instructions="Always reply in French."' --dangerously-bypass-approvals-and-sandbox -c 'web_search="disabled"' -c 'mcp_servers.ressac={url="http://host.docker.internal:'"$MCP_PORT"'/mcp",bearer_token_env_var="RESSAC_MCP_TOKEN"}' --disable shell_tool -c 'mcp_servers.ressac.disabled_tools=["launch_app"]' -c 'notify=[]' -c 'model_provider="openai"' -c 'model_provider="ressac-api"' -c 'model_providers.ressac-api={name="API compatible",base_url="http://host.docker.internal:'"$RELAY_PORT"'",env_key="RESSAC_ENGINE_TOKEN"}' -m bench-model 'bench codex probe' > /tmp/cx.out 2>&1
echo exit=$?; tail -c 500 /tmp/cx.out; echo; ls /tmp/MARK-* 2>&1
