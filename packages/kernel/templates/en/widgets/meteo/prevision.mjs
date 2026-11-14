// Weather: from the geocoding (block `geo`), the Open-Meteo forecast, no AI. Runs in the container without network.
const LABELS = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Violent showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
};
const label = (code) => LABELS[code] ?? "Unknown weather";

/** `geo`: the geocoding response (null without a city set). */
export default async (geo, ressac) => {
  const city = typeof ressac.config?.ville === "string" ? ressac.config.ville.trim() : "";
  if (!city) return { ville: null };

  const place = geo?.results?.[0];
  if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
    throw new Error(`City not found: ${city}`);
  }
  const p = await ressac.fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code" +
      "&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=5",
    { format: "json" },
  );
  if (!p?.current || !p?.hourly?.time || !p?.daily?.time) throw new Error("Unexpected forecast response");

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
