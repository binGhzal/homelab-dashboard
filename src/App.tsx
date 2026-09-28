import { useEffect, useRef, useState } from "react";
import { IconHome, IconRefresh, IconArrowRight } from "@tabler/icons-react";
import type {
  Preferences,
  PreferencesResponse,
  PublicApp,
  User,
} from "../shared/types";
import { api, ApiError } from "./api";
import { Weather } from "./components/Weather";
import { Desktop } from "./components/Desktop";
function greeting(name: string | null): string {
  const hour = new Date().getHours();
  const text =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${text}, ${name}.` : `${text}.`;
}
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [apps, setApps] = useState<PublicApp[]>([]);
  const [layout, setLayout] = useState<PreferencesResponse | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "signed-out" | "error"
  >("loading");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const signedOut = useRef(false);
  const savingRef = useRef(false);
  const generation = useRef(0);
  async function refresh() {
    if (signedOut.current || savingRef.current) return;
    const attempt = ++generation.current;
    try {
      const identity = await api<User>("/api/user");
      const [catalogue, preferences] = await Promise.all([
        api<{ apps: PublicApp[] }>("/api/apps"),
        api<PreferencesResponse>("/api/preferences"),
      ]);
      if (
        signedOut.current ||
        savingRef.current ||
        attempt !== generation.current
      )
        return;
      setUser(identity);
      setApps(catalogue.apps);
      setLayout(preferences);
      setStatus("ready");
    } catch (error) {
      if (
        signedOut.current ||
        savingRef.current ||
        attempt !== generation.current
      )
        return;
      setUser(null);
      setApps([]);
      setLayout(null);
      const unauthorized = error instanceof ApiError && error.status === 401;
      setStatus(unauthorized ? "signed-out" : "error");
      if (
        unauthorized &&
        !signedOut.current &&
        !new URLSearchParams(location.search).has("auth")
      ) {
        try {
          const last = Number(
            sessionStorage.getItem("dashboard-auto-login-at") ?? "0",
          );
          if (Date.now() - last > 60000) {
            sessionStorage.setItem(
              "dashboard-auto-login-at",
              String(Date.now()),
            );
            location.assign("/auth/login");
          }
        } catch {
          /* The explicit sign-in control remains available. */
        }
      }
    }
  }
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  async function save(preferences: Preferences) {
    if (!user || !layout || savingRef.current) return;
    savingRef.current = true;
    generation.current++;
    setSaving(true);
    setActionError("");
    try {
      setLayout(
        await api<PreferencesResponse>("/api/preferences", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": user.csrfToken,
          },
          body: JSON.stringify({ revision: layout.revision, preferences }),
        }),
      );
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? "Your layout changed in another browser. Refresh and try again."
          : "Could not save your layout. Please try again.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  async function logout() {
    if (!user) return;
    setActionError("");
    try {
      await api("/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": user.csrfToken },
      });
      signedOut.current = true;
      generation.current++;
      setUser(null);
      setApps([]);
      setLayout(null);
      setStatus("signed-out");
    } catch {
      setActionError("Could not sign out. Please try again.");
    }
  }
  const authError = new URLSearchParams(location.search).get("auth");
  if (status !== "ready" || !user || !layout)
    return (
      <div className="page welcome-page">
        <main className="welcome-shell">
          <div className="welcome-panel">
            <IconHome size={53} stroke={1.4} />
            <h1>
              {status === "loading"
                ? "Opening your home…"
                : status === "error"
                  ? "We couldn’t load your home."
                  : "Welcome home."}
            </h1>
            <p>
              {status === "loading"
                ? "Just a moment."
                : status === "error"
                  ? "Your dashboard is temporarily unavailable. Give it another try."
                  : authError === "denied"
                    ? "Your account has not been granted access. Contact your administrator."
                    : authError === "failed"
                      ? "Sign-in could not be completed. Please try again."
                      : "Sign in to open your apps."}
            </p>
            {status === "error" ? (
              <button className="button primary" onClick={() => void refresh()}>
                <IconRefresh size={18} />
                Try again
              </button>
            ) : (
              status !== "loading" && (
                <a className="button primary" href="/auth/login">
                  Sign in
                  <IconArrowRight size={18} />
                </a>
              )
            )}
          </div>
        </main>
      </div>
    );
  return (
    <div
      className={`page desktop-page wallpaper-${layout.preferences.wallpaper}`}
      style={
        {
          "--wallpaper-image": user.wallpaper
            ? `url("${user.wallpaper}")`
            : "none",
        } as React.CSSProperties
      }
    >
      <main className="dashboard">
        <section className="greeting-section">
          <IconHome
            className="home-emblem"
            size={58}
            stroke={1.4}
            aria-hidden="true"
          />
          <h1>{greeting(user.givenName)}</h1>
        </section>
        <div className="desktop-information">
          {user.weatherEnabled && <Weather demo={user.demo} />}
          <div className="date-block">
            <span>
              {new Date().toLocaleDateString(undefined, { weekday: "long" })}
            </span>
            <strong>
              {new Date().toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
              })}
            </strong>
          </div>
        </div>
        {actionError && (
          <div className="notice" role="alert">
            {actionError}
            <button className="text-button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        )}
        <Desktop
          user={user}
          apps={apps}
          preferences={layout.preferences}
          query={query}
          setQuery={setQuery}
          save={save}
          saving={saving}
          logout={() => void logout()}
        />
        <footer className="footer">
          <span role="status">
            {saving
              ? "Saving layout…"
              : user.demo
                ? "Local demo · Synthetic account and apps"
                : ""}
          </span>
          {user.weatherEnabled && (
            <a
              href="https://open-meteo.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Weather by Open-Meteo
            </a>
          )}
        </footer>
      </main>
    </div>
  );
}
