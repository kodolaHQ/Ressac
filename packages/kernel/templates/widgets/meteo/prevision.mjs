// Weather: from the geocoding (block `geo`), the Open-Meteo forecast, no AI. Runs in the container without network.
const LABELS = {
  0: "Ciel dégagé", 1: "Peu nuageux", 2: "Partiellement nuageux", 3: "Couvert",
  45: "Brouillard", 48: "Brouillard givrant",
  51: "Bruine légère", 53: "Bruine", 55: "Bruine forte", 56: "Bruine verglaçante", 57: "Bruine verglaçante forte",
  61: "Pluie faible", 63: "Pluie", 65: "Pluie forte", 66: "Pluie verglaçante", 67: "Pluie verglaçante forte",
  71: "Neige faible", 73: "Neige", 75: "Neige forte", 77: "Grains de neige",
  80: "Averses faibles", 81: "Averses", 82: "Averses violentes", 85: "Averses de neige", 86: "Fortes averses de neige",
  95: "Orage", 96: "Orage avec grêle", 99: "Orage violent avec grêle",
};
const label = (code) => LABELS[code] ?? "Temps inconnu";

/** `geo`: the geocoding response (null without a city set). */
export default async (geo, webaios) => {
  const city = typeof webaios.config?.ville === "string" ? webaios.config.ville.trim() : "";
  if (!city) return { ville: null };

  const place = geo?.results?.[0];
  if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
    throw new Error(`Ville introuvable : ${city}`);
  }
  const p = await webaios.fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code" +
      "&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=5",
    { format: "json" },
  );
  if (!p?.current || !p?.hourly?.time || !p?.daily?.time) throw new Error("Réponse de prévision inattendue");

  const now = String(p.current.time ?? "");
  let first = p.hourly.time.findIndex((t) => t > now);
  if (first < 0) first = 0;
  const hours = p.hourly.time.slice(first, first + 12).map((t, k) => {
    const code = p.hourly.weather_code[first + k];
    return { heure: String(t).slice(11, 16), temperature: Math.round(p.hourly.temperature_2m[first + k]), code, libelle: label(code) };
  });
  const days = p.daily.time.slice(0, 5).map((date, k) => {
    const code = p.daily.weather_code[k];
    return { date, min: Math.round(p.daily.temperature_2m_min[k]), max: Math.round(p.daily.temperature_2m_max[k]), code, libelle: label(code) };
  });
  return {
    ville: place.name || city,
    actuel: { temperature: Math.round(p.current.temperature_2m), code: p.current.weather_code, libelle: label(p.current.weather_code) },
    heures: hours,
    jours: days,
  };
};
