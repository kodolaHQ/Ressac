// Weather: the city set, trimmed; null without a city (the geocoding is then not launched).
export default async (_input, ressac) => {
  const city = typeof ressac.config?.ville === "string" ? ressac.config.ville.trim() : "";
  return city ? { ville: city } : null;
};
