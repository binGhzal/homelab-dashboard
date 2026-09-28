# Third-party notices

Homelab Dashboard's original application code is MIT licensed. Dependency and
brand rights remain with their respective owners. This project is not affiliated
with or endorsed by Umbrel, the applications linked from the dashboard, or their
trademark owners. No Umbrel source code, fonts, logos, screenshots, or wallpapers
are included.

## Browser assets

- **React and React DOM 19.3.0**: MIT, copyright Meta Platforms, Inc. and affiliates.
  Their bundled scheduler carries the same notice. The full notice is retained in
  [docs/licenses/react.txt](docs/licenses/react.txt).
- **Tabler Icons React 3.48.0**: MIT, copyright 2020–2026 Paweł Kuna. Interface
  pictograms come from this package. Full notice:
  [docs/licenses/tabler.txt](docs/licenses/tabler.txt).
- **Simple Icons 16.32.0**: CC0 1.0 Universal. Five bundled brand SVGs under
  `public/icons` are derived from its package: Jellyfin, Sonarr, Radarr, Grafana,
  and Authentik. Only the SVG fill color was added. Full dedication:
  [docs/licenses/simple-icons.txt](docs/licenses/simple-icons.txt).
  See the [upstream licensing and trademark guidance](https://github.com/simple-icons/simple-icons#license).
  CC0 does not grant trademark rights. Review each application's branding guidance
  when using its name or logo in your own distribution.
- **Landscape wallpaper**: generated specifically for this project with OpenAI's
  image generation service in September 2026; no Umbrel image was used as an
  input. The resulting image was encoded as WebP. The project includes the image
  under the same distribution terms as its original assets, to the extent
  copyright rights exist. No third-party ownership or exclusivity is asserted.

Simple Icons records the following sources for the included marks:

| Asset     | Upstream source                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Jellyfin  | https://jellyfin.org/docs/general/contributing/branding.html                                              |
| Sonarr    | https://github.com/Sonarr/Sonarr/blob/913b845faadc3c9fc005abfba815426743d01bdf/Logo/Sonarr.svg            |
| Radarr    | https://github.com/Radarr/Radarr/blob/5f624a147bb62d37b731d9a0ae02bfd338793962/Logo/Radarr.svg            |
| Grafana   | https://grafana.com                                                                                       |
| Authentik | https://github.com/goauthentik/authentik/blob/2c64f72ebc57dad9789c1fb799dd7cd39003d043/web/icons/icon.svg |

## Weather service

Optional weather data is attributed to Open-Meteo and is offered under
[CC BY 4.0](https://open-meteo.com/en/licence). Access to its hosted free API is
subject to [separate noncommercial service terms](https://open-meteo.com/en/terms).
This does not change the application's MIT license. Commercial deployments must
disable the integration (`weatherEnabled: false`) or implement an appropriately
licensed service arrangement; the current direct-browser integration does not
accept paid-service API keys.

## Other dependencies

Exact direct and transitive versions are recorded in `pnpm-lock.yaml`. Server
packages retain their own license files in the production dependency tree.
OpenTelemetry packages use Apache-2.0; Fastify, openid-client and Zod use MIT;
YAML uses ISC. Build-time tools have their own notices and are not application
assets.
