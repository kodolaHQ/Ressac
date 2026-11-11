export type TipId = "ctrl-tab" | "cmd-t" | "cmd-l" | "cmd-j" | "spaces" | "design-mode";
export type FirstTimeId = "agent" | "design" | "actions";
export type HintId = TipId | FirstTimeId;

export const TIPS: { id: TipId; text: string; keys?: string; tryIt?: "command" | "agent" }[] = [
  { id: "ctrl-tab", keys: "⌃Tab", text: "Passez d'un onglet récent à l'autre avec ⌃Tab ; maintenez ⌃ pour choisir dans la liste." },
  { id: "cmd-t", keys: "⌘T", tryIt: "command", text: "⌘T ouvre un onglet ou retrouve une page parmi vos onglets, votre historique et le web." },
  { id: "cmd-l", keys: "⌘L", text: "⌘L modifie l'adresse de l'onglet affiché." },
  { id: "cmd-j", keys: "⌘J", tryIt: "agent", text: "⌘J ouvre ou ferme le panneau de l'agent." },
  { id: "spaces", text: "Un espace par sujet : le + en bas de la barre en crée un, avec son aura." },
  { id: "design-mode", text: "Le crayon en haut de la barre lance le mode design : montrez un élément de la page à l'agent." },
];

export const FIRST_TIME: Record<FirstTimeId, { title: string; text: string }> = {
  agent: { title: "L'agent", text: "Claude Code ou Codex travaille dans un conteneur à part, sur votre Mac. Il ne lit un onglet ou n'agit sur une page qu'avec votre accord, et un halo entoure la page quand il agit." },
  design: { title: "Le mode design", text: "Cliquez sur un élément de la page pour y laisser une remarque. Vos remarques vont dans le panier, puis à l'agent." },
  actions: { title: "Les actions", text: "Une action est une petite appli que l'agent construit pour vous. Elle ne lit vos comptes qu'avec votre accord." },
};

export const HINT_IDS = [...TIPS.map((t) => t.id), ...(Object.keys(FIRST_TIME) as FirstTimeId[])] as unknown as readonly [HintId, ...HintId[]];

/** The first tip not seen yet. */
export function nextTip(seen: readonly string[]): (typeof TIPS)[number] | null {
  return TIPS.find((t) => !seen.includes(t.id)) ?? null;
}
