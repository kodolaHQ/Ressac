// Weather: the city set, trimmed; null without a city (the geocoding is then not launched).
export default async (_input, webaios) => {
  const city = typeof webaios.config?.ville === "string" ? webaios.config.ville.trim() : "";
  return city ? { ville: city } : null;
};
