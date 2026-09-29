export interface BrandIcon {
  src?: string;
  unavailable?: boolean;
}

// Unmodified upstream artwork. Provenance and licenses: docs/licenses/brand-assets.md.
// Unavailable marks have no bundled copy; remote collection lookup is independent.
export const brandIcons: Readonly<Record<string, BrandIcon>> = {
  jellyfin: { src: "/icons/jellyfin.svg" },
  immich: { src: "/icons/immich.svg" },
  seerr: { src: "/icons/seerr.png" },
  sonarr: { src: "/icons/sonarr.svg" },
  radarr: { src: "/icons/radarr.svg" },
  prowlarr: { src: "/icons/prowlarr.svg" },
  bazarr: { src: "/icons/bazarr.png" },
  listseerr: { src: "/icons/listseerr.png" },
  decypharr: { src: "/icons/decypharr.png" },
  authentik: { src: "/icons/authentik.svg" },
  "paperless-ngx": { src: "/icons/paperless-ngx.svg" },
  audiobookshelf: { src: "/icons/audiobookshelf.svg" },
  vaultwarden: { src: "/icons/vaultwarden.svg" },
  syncthing: { src: "/icons/syncthing.svg" },
  gitea: { src: "/icons/gitea.svg" },
  freshrss: { src: "/icons/freshrss.svg" },
  grafana: { unavailable: true },
  nextcloud: { unavailable: true },
  "home-assistant": { unavailable: true },
  homeassistant: { unavailable: true },
};
