// Météo : géocodage puis prévision Open-Meteo, sans IA. Tourne dans le conteneur sans réseau.
const LIBELLES = {
  0: "Ciel dégagé", 1: "Peu nuageux", 2: "Partiellement nuageux", 3: "Couvert",
  45: "Brouillard", 48: "Brouillard givrant",
  51: "Bruine légère", 53: "Bruine", 55: "Bruine forte", 56: "Bruine verglaçante", 57: "Bruine verglaçante forte",
  61: "Pluie faible", 63: "Pluie", 65: "Pluie forte", 66: "Pluie verglaçante", 67: "Pluie verglaçante forte",
  71: "Neige faible", 73: "Neige", 75: "Neige forte", 77: "Grains de neige",
  80: "Averses faibles", 81: "Averses", 82: "Averses violentes", 85: "Averses de neige", 86: "Fortes averses de neige",
  95: "Orage", 96: "Orage avec grêle", 99: "Orage violent avec grêle",
};
const libelle = (code) => LIBELLES[code] ?? "Temps inconnu";

export default async (webaios) => {
  const ville = typeof webaios.config?.ville === "string" ? webaios.config.ville.trim() : "";
  if (!ville) return { ville: null };

  const geo = await webaios.recuperer(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(ville)}&count=1&language=fr`,
    { format: "json" },
  );
  const lieu = geo?.results?.[0];
  if (!lieu || typeof lieu.latitude !== "number" || typeof lieu.longitude !== "number") {
    throw new Error(`Ville introuvable : ${ville}`);
  }
  const p = await webaios.recuperer(
    `https://api.open-meteo.com/v1/forecast?latitude=${lieu.latitude}&longitude=${lieu.longitude}` +
      "&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code" +
      "&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=5",
    { format: "json" },
  );
  if (!p?.current || !p?.hourly?.time || !p?.daily?.time) throw new Error("Réponse de prévision inattendue");

  const maintenant = String(p.current.time ?? "");
  let debut = p.hourly.time.findIndex((t) => t > maintenant);
  if (debut < 0) debut = 0;
  const heures = p.hourly.time.slice(debut, debut + 12).map((t, k) => {
    const code = p.hourly.weather_code[debut + k];
    return { heure: String(t).slice(11, 16), temperature: Math.round(p.hourly.temperature_2m[debut + k]), code, libelle: libelle(code) };
  });
  const jours = p.daily.time.slice(0, 5).map((date, k) => {
    const code = p.daily.weather_code[k];
    return { date, min: Math.round(p.daily.temperature_2m_min[k]), max: Math.round(p.daily.temperature_2m_max[k]), code, libelle: libelle(code) };
  });
  return {
    ville: lieu.name || ville,
    actuel: { temperature: Math.round(p.current.temperature_2m), code: p.current.weather_code, libelle: libelle(p.current.weather_code) },
    heures,
    jours,
  };
};
