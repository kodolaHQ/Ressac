// Météo : la ville réglée, rognée ; null sans ville (le géocodage n'est alors pas lancé).
export default async (_entree, webaios) => {
  const ville = typeof webaios.config?.ville === "string" ? webaios.config.ville.trim() : "";
  return ville ? { ville } : null;
};
