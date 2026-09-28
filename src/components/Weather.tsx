import { useEffect, useRef, useState } from "react";
import {
  IconCloud,
  IconCloudRain,
  IconCloudSnow,
  IconCloudStorm,
  IconSun,
  IconSunHigh,
  IconLocation,
} from "@tabler/icons-react";
interface WeatherData {
  temperature: number;
  code: number;
}
function description(code: number): string {
  if (code === 0) return "Clear skies";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorms";
}
function WeatherIcon({ code }: { code: number }) {
  const Icon =
    code === 0
      ? IconSun
      : code <= 3
        ? IconSunHigh
        : code <= 48
          ? IconCloud
          : code >= 95
            ? IconCloudStorm
            : (code >= 71 && code <= 77) || (code >= 85 && code <= 86)
              ? IconCloudSnow
              : IconCloudRain;
  return <Icon size={53} stroke={1.4} aria-hidden="true" />;
}
export function Weather({ demo }: { demo: boolean }) {
  const [data, setData] = useState<WeatherData | null>(
    demo ? { temperature: 22, code: 2 } : null,
  );
  const [state, setState] = useState<"off" | "loading" | "ready" | "error">(
    demo ? "ready" : "off",
  );
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  async function enable() {
    const attempt = ++generation.current;
    if (!navigator.geolocation) {
      setError("Location is unavailable in this browser.");
      setState("error");
      return;
    }
    setState("loading");
    setError("");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (generation.current !== attempt) return;
        const abort = new AbortController();
        controller.current = abort;
        const timeout = window.setTimeout(() => abort.abort(), 10000);
        try {
          // Reduce to roughly 11 km before contacting the provider. Nothing is stored.
          const latitude = position.coords.latitude.toFixed(1);
          const longitude = position.coords.longitude.toFixed(1);
          const url = new URL("https://api.open-meteo.com/v1/forecast");
          url.search = new URLSearchParams({
            latitude,
            longitude,
            current: "temperature_2m,weather_code",
            forecast_days: "1",
          }).toString();
          const response = await fetch(url, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: abort.signal,
          });
          if (!response.ok) throw new Error("Weather unavailable");
          const body = await response.json();
          if (
            typeof body.current?.temperature_2m !== "number" ||
            typeof body.current?.weather_code !== "number"
          )
            throw new Error("Invalid weather");
          if (generation.current === attempt) {
            setData({
              temperature: body.current.temperature_2m,
              code: body.current.weather_code,
            });
            setState("ready");
          }
        } catch {
          if (generation.current === attempt) {
            setState("error");
            setError("Weather is unavailable right now. Try again later.");
          }
        } finally {
          window.clearTimeout(timeout);
        }
      },
      (geolocationError) => {
        if (generation.current !== attempt) return;
        setState("error");
        setError(
          geolocationError.code === 1
            ? "Location was not shared. Your dashboard still works."
            : "Could not find your location. Try again.",
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }
  function disable() {
    generation.current++;
    controller.current?.abort();
    setData(null);
    setState("off");
  }
  return (
    <section className="weather" aria-label="Local weather">
      {state === "ready" && data ? (
        <>
          <WeatherIcon code={data.code} />
          <div>
            <div className="temperature">
              {Math.round(data.temperature)}
              <span>°C</span>
            </div>
            <p>{description(data.code)}</p>
            <button className="text-button weather-toggle" onClick={disable}>
              {demo ? "Sample weather · Hide" : "Location enabled · Clear"}
            </button>
          </div>
        </>
      ) : (
        <div className="weather-setup">
          <IconSunHigh size={34} stroke={1.5} aria-hidden="true" />
          <div>
            <p>Weather near you</p>
            <button
              className="text-button"
              disabled={state === "loading"}
              onClick={() => void enable()}
            >
              <IconLocation size={14} aria-hidden="true" />
              {state === "loading"
                ? "Finding your weather…"
                : "Use my location"}
            </button>
            <small>
              {state === "error"
                ? error
                : "Optional. Approximate location, never saved."}
            </small>
          </div>
        </div>
      )}
    </section>
  );
}
