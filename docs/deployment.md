# Deployment

min.ug is a static browser application. The production artifact is `web/dist/`; it needs no
application server, database, redirects, or secrets.

Build and verify it with:

```sh
npm ci
npm run check
npm run build:web
npm run preview
```

The build refuses to publish if the bundled V1 Wasm artifact does not match its frozen SHA-256.
Production must serve the app at `https://min.ug/`, because that origin is part of every displayed
link. Unknown paths should serve `index.html` or the generated `404.html` fallback.

## Cloudflare Workers

`wrangler.jsonc` deploys `web/dist/` as static assets. For a checked local deployment:

```sh
npm run deploy:checked
```

For automatic deployments, import the GitHub repository in **Cloudflare → Workers & Pages →
Create application → Import a repository** and use:

| Setting | Value |
| --- | --- |
| Worker name | `min-ug` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `npm run check && npm run build:web` |
| Deploy command | `npm run deploy` |

After the first `workers.dev` deployment verifies, attach `min.ug` under **Settings → Domains &
Routes → Add → Custom Domain**. The domain must already be an active Cloudflare DNS zone. Do not
add GitHub Pages records; Cloudflare creates the Worker DNS record and certificate.
