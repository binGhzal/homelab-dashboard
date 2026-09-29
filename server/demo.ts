import { catalogSchema } from "./config.js";
import type { Identity } from "./access.js";

export const demoIdentity: Identity = {
  sub: "local-demo",
  givenName: "Alex",
  displayName: "Alex Morgan",
  groups: ["demo-admins"],
};

// Illustrative public applications and reserved example domains only.
const apps = [
  ["jellyfin", "Jellyfin", "Your movies, series and music", "Media"],
  ["immich", "Immich", "A home for your photos and videos", "Photos"],
  ["seerr", "Seerr", "Discover and request something to watch", "Media"],
  [
    "paperless-ngx",
    "Paperless-ngx",
    "Find your documents in one place",
    "Documents",
  ],
  ["audiobookshelf", "Audiobookshelf", "Your audiobooks and podcasts", "Audio"],
  ["vaultwarden", "Vaultwarden", "Your personal password vault", "Utilities"],
  ["syncthing", "Syncthing", "Keep your files in sync", "Files"],
  ["gitea", "Gitea", "A place for your code and projects", "Development"],
  ["freshrss", "FreshRSS", "Follow your favorite publications", "Reading"],
];

export const demoCatalog = catalogSchema.parse({
  version: 1,
  title: "Home",
  adminGroups: ["demo-admins"],
  access: { allowAdmin: true },
  apps: apps.map(([id, name, description, category]) => ({
    id,
    name,
    description,
    category,
    href: `https://${id}.example.com`,
    icon: "link",
    color: "#edf1f5",
    iconPath: `/icons/${id}.${id === "seerr" ? "png" : "svg"}`,
    access: { allowAdmin: true },
  })),
});
