const MAX = 50;
const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Champs proposés dans un gabarit : clés du premier élément (ou de l'objet), puis `config.<clé>`. */
export function champsDisponibles(sortieAmont: unknown, config: unknown): string[] {
  const exemple = Array.isArray(sortieAmont) ? sortieAmont[0] : sortieAmont;
  const champs = estObjet(exemple) ? Object.keys(exemple) : [];
  if (estObjet(config)) champs.push(...Object.keys(config).map((k) => `config.${k}`));
  return champs.slice(0, MAX);
}
