# Cloudflare Pages

Use the native GitHub integration so a push to `main` builds the website without an SSH deployment or a Cloudflare token in GitHub Actions.

| Project setting | Value |
| --- | --- |
| Repository | `risense-ai/respire-site` |
| Production branch | `main` |
| Root directory | `homepage` |
| Build command | `npm run check && npm test && npm run build` |
| Build output directory | `../site/dist/client` |
| Environment variable | `NODE_VERSION=22` |
| Custom domain | `rsrs.rs` |

Connect the repository through **Workers & Pages → Create application → Pages → Import an existing Git repository**. Limit the Cloudflare GitHub application's repository access to this repository. Keep branch previews enabled so pull requests can be checked before merging.

The existing GitHub Site CI runs the production and development browser checks. Pages builds the production distribution only; `homepage/assets/_redirects` retains the dashboard and admin entry points. Both language entries and all font files are served locally. Font licenses are included under `/licenses/`.

Before attaching the custom domain, verify the Pages preview at `/` and `/zh/`, the dashboard/admin redirects, mobile navigation and all asset requests. Attach `rsrs.rs` through the project's **Custom domains** settings so Pages provisions its certificate and DNS. Leave `dash.rsrs.rs`, `admin.rsrs.rs`, `api.rsrs.rs` and `dev.rsrs.rs` unchanged.

Retain the old website files for rollback. Stop only the old static website service after the custom domain passes verification; the API, account dashboard, administration and legacy API routing remain on their existing services.

See [Cloudflare Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/), [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/) and [custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).
