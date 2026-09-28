import { catalogSchema } from "./config.js";
import type { Identity } from "./access.js";
export const demoIdentity: Identity = {
  sub: "local-demo",
  givenName: "Alex",
  displayName: "Alex Morgan",
  groups: ["demo-admins"],
};
const names = [
  ["jellyfin", "Jellyfin", "play", "#181526", "Your movies, series and music"],
  ["seerr", "Seerr", "tickets", "#287bea", "Find your next watch"],
  ["sonarr", "Sonarr", "tv", "#174250", "Your series and anime"],
  ["radarr", "Radarr", "film", "#ca9a45", "Your movie collection"],
  ["prowlarr", "Prowlarr", "search", "#cd776b", "Search your indexers"],
  ["bazarr", "Bazarr", "subtitles", "#7566dc", "Subtitles for every story"],
  [
    "listseerr",
    "Listseerr",
    "list",
    "#189bb0",
    "Turn watchlists into requests",
  ],
  ["decypharr", "Decypharr", "download", "#b94f86", "Manage your downloads"],
  ["grafana", "Grafana", "chart", "#17202d", "Your system dashboards"],
];
export const demoCatalog = catalogSchema.parse({
  version: 1,
  title: "Home",
  adminGroups: ["demo-admins"],
  access: { allowAdmin: true },
  apps: names.map(([id, name, icon, color, description]) => ({
    id,
    name,
    icon,
    color,
    description,
    href: `https://${id}.example.com`,
    category: "Media",
    access: { allowAdmin: true },
    ...(["jellyfin", "sonarr", "radarr", "grafana"].includes(id)
      ? { iconPath: `/icons/${id}.svg` }
      : {}),
  })),
});
