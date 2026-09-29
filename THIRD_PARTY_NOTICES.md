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
- **Official application artwork**: 16 unmodified SVG/PNG assets are bundled from
  the applications’ own repositories, with their native colors. Each asset retains
  its upstream license; these include MIT, GPLv3, AGPLv3, MPL-2.0, and CC BY-SA 4.0.
  Attribution, immutable source links, license copies, trademark considerations,
  and the three deliberately omitted marks are recorded in
  [docs/licenses/brand-assets.md](docs/licenses/brand-assets.md). Exact source paths
  and SHA-256 hashes are in
  [docs/licenses/brand-assets.json](docs/licenses/brand-assets.json).
  The MIT license for the dashboard’s original code does not relicense this
  separately distributed artwork. The original SVG/PNG files accompany the
  application, and the container includes these notices and license texts.
  No Simple Icons brand artwork remains in the distribution.
- **Remote icon collection: [selfh.st/icons](https://selfh.st/icons/)**, maintained
  by selfh.st and contributors and offered under
  [CC BY 4.0](https://github.com/selfhst/icons/blob/main/LICENSE).
  The default icon integration requests the collection's index and available
  original-color images through jsDelivr. These remote files are not bundled or
  recolored by this project; the local fallback artwork above is distributed
  separately. Collection credit does not replace each original owner's copyright
  or trademark conditions. Set an application's `iconSource` to `local` to use
  only local artwork. Integration details and rights limitations are recorded in
  [docs/licenses/brand-assets.md](docs/licenses/brand-assets.md#remote-selfhst-icon-collection).
- **Landscape wallpaper**: generated specifically for this project with OpenAI's
  image generation service in September 2026; no Umbrel image was used as an
  input. The resulting image was encoded as WebP. The project includes the image
  under the same distribution terms as its original assets, to the extent
  copyright rights exist. No third-party ownership or exclusivity is asserted.

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
