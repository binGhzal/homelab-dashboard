export type IconName =
  | "play"
  | "tickets"
  | "tv"
  | "film"
  | "search"
  | "subtitles"
  | "list"
  | "download"
  | "settings"
  | "chart"
  | "users"
  | "link";
export interface PublicApp {
  id: string;
  name: string;
  description: string;
  href: string;
  icon: IconName;
  iconPath?: string;
  iconSlug?: string;
  iconSource?: "selfhst" | "local";
  color: string;
  category: string;
}
export interface User {
  givenName: string | null;
  displayName: string;
  admin: boolean;
  csrfToken: string;
  demo: boolean;
  title: string;
  wallpaper: string | null;
  weatherEnabled: boolean;
}
export interface Folder {
  id: string;
  name: string;
  appIds: string[];
}
export interface Preferences {
  version: 1;
  order: string[];
  folders: Folder[];
  dock: string[];
  wallpaper: "landscape" | "midnight" | "dusk";
}
export interface PreferencesResponse {
  revision: number;
  catalogRevision?: string;
  preferences: Preferences;
}
