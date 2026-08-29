# min.ug

min.ug turns long URLs into shorter, self-contained links.

Compression and decompression happen entirely client-side in the browser. There is no link database: the destination is encoded after `min.ug#`, so the server never receives it. Links can be copied as text or saved as QR codes, with optional cleanup for common tracking parameters.

To run it locally:

```sh
npm install
npm run dev
```

min.ug takes inspiration from [ha.mr](https://github.com/p2r3/ha.mr) and aims to improve on it with greater extensibility and more efficient compression.