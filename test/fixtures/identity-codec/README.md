# Identity codec fixture

This fixture implements the min.ug codec ABI without compressing anything. `encode` and
`decode` each allocate and return a distinct byte-for-byte copy of their input. It exists to
test the JavaScript/WASM boundary independently of any future compression algorithm.

The committed `identity.wasm` is rebuilt from the repository root with:

```text
npm run fixture:identity
```

Rust is only needed to rebuild the fixture. Running the Node test suite uses the committed
artifact and remains dependency-free.
