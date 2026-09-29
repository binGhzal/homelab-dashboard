import { useEffect, useState } from "react";
import type { PublicApp } from "../../shared/types";
import { iconCatalogLoader, iconSources } from "../icon-catalog";

export function AppArtwork({
  app,
  small = false,
}: {
  app: PublicApp;
  small?: boolean;
}) {
  const [catalog, setCatalog] = useState(iconCatalogLoader.peek);
  const [failedSources, setFailedSources] = useState<string[]>([]);
  useEffect(() => {
    if (app.iconSource === "local") return;
    let active = true;
    void iconCatalogLoader.load().then((result) => {
      if (active) setCatalog(result);
    });
    return () => {
      active = false;
    };
  }, [app.iconSource]);
  useEffect(() => {
    setFailedSources([]);
  }, [app.id, app.iconPath, app.iconSlug, app.iconSource]);
  const source = iconSources(app, catalog).find(
    (candidate) => !failedSources.includes(candidate),
  );
  const available = Boolean(source);
  return (
    <span
      className={`app-icon${small ? " app-icon-small" : ""}${available ? " has-artwork" : " app-monogram"}`}
      data-brand={app.id}
      aria-hidden="true"
    >
      {source ? (
        <img
          key={source}
          src={source}
          alt=""
          draggable={false}
          decoding="async"
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          onError={() =>
            setFailedSources((failed) =>
              failed.includes(source) ? failed : [...failed, source],
            )
          }
        />
      ) : (
        <span>{app.name.slice(0, 2).toLocaleUpperCase()}</span>
      )}
    </span>
  );
}
