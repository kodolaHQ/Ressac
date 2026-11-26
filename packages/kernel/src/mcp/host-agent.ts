/** The tools of the agent that runs in the host against the user's own model (« Votre modèle »): reads and moves only, nothing that acts. */
export const HOST_AGENT_TOOLS: readonly string[] = ["current_page", "list_tabs", "read_tab", "navigate", "open_tab", "search_web", "read_pages", "hand_over", "search_history", "read_history", "search_bookmarks"];

/** The host loop's own tools: its token may call them, the model never picks them (its action enum is HOST_AGENT_TOOLS). */
export const HOST_LOOP_ONLY: ReadonlySet<string> = new Set(["active_tab"]);
/** What a « Votre modèle » session's token may list and call. */
export const HOST_LOOP_TOOLS: readonly string[] = [...HOST_AGENT_TOOLS, ...HOST_LOOP_ONLY];
/** Added to a host session whose model runs off this Mac (an Ollama cloud model, a remote API): the same fill Claude's Browser session has. */
export const HOST_FILL_TOOLS: readonly string[] = ["fill_field"];
