import { useState } from "react";
import type { PublicApp } from "../../shared/types";
import { brandIcons } from "../brand-icons";

export function AppArtwork({
  app,
  small = false,
}: {
  app: PublicApp;
  small?: boolean;
}) {
  const artwork = brandIcons[app.id];
  const source = artwork?.unavailable
    ? undefined
    : (artwork?.src ?? app.iconPath);
  const [failedSource, setFailedSource] = useState<string>();
  const available = source && failedSource !== source;
  return (
    <span
      className={`app-icon${small ? " app-icon-small" : ""}${available ? " has-artwork" : " app-monogram"}`}
      data-brand={app.id}
      aria-hidden="true"
    >
      {available ? (
        <img
          src={source}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <span>{app.name.slice(0, 2).toLocaleUpperCase()}</span>
      )}
    </span>
  );
}
