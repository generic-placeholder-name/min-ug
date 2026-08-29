# Browser frontend

The browser app keeps the same useful constraint as [ha.mr](https://github.com/p2r3/ha.mr):
compression, QR generation, and decoding happen locally. min.ug loads the frozen V1 Wasm artifact,
applies `Clean`, and emits a fragment link without creating a server-side redirect record.

## Local use

```powershell
npm run dev
```

Open `http://localhost:5173/`. In local development, clicking a generated link opens that fragment
through the local decoder. The Copy button writes exactly the visible `min.ug#…` form. Test the QR
layout at a narrow viewport and save the generated PNG to exercise the download path.

For the production artifact:

```powershell
npm run build:web
npm run preview
```

The preview runs at `http://localhost:4173/`. `web/dist/` is the complete static artifact. The
build fails unless its emitted Wasm file has the frozen V1 SHA-256.

## What was retained from ha.mr

- The app is static and needs no database or URL API.
- The QR dependency is loaded only after QR output is requested.
- A `404.html` app-shell fallback is emitted for static hosts and simple nginx configurations.
- A decoded link asks for confirmation instead of navigating without showing its destination.

ha.mr also encodes a QR-specific payload in the request path, which makes its fallback routing
mandatory. min.ug uses the same fragment link for text and QR output, so the payload never reaches
the host and the fallback is only defensive. Its Nix package, standalone bundle, and nginx Docker
wrapper are useful distribution options but are not required for a static min.ug deployment.

## Hosting

The host serves `web/dist/` at the domain root. Deployment requirements are kept in
[`deployment.md`](deployment.md).
