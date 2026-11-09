// Weather: the city set, trimmed; null without a city (the geocoding is then not launched).
export default async (_entree, webaios) => {
  const ville = typeof webaios.config?.ville === "string" ? webaios.config.ville.trim() : "";
  return ville ? { ville } : null;
};
