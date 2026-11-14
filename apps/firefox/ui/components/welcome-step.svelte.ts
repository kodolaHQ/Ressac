/**
 * The welcome's step, kept while it steps aside for an install page (UI only: nothing is saved before it is finished).
 * `aiAtStart`: a replay (« Revoir l'accueil ») started with AI already on, so it skips the AI pages; read once, at its first show.
 */
export const welcomeStep = $state<{ page: number; aside: boolean; aiAtStart?: boolean }>({ page: 1, aside: false });
