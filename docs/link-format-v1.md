# min.ug link format v1

The public ASCII form is `min.ug#<rendered-frame>`. Deployment forces HTTPS, while the fragment
keeps the destination payload out of HTTP requests, intermediary logs, and referrer headers. The
browser reads `location.hash`; no server-side route contains compressed data.

This link format is distinct from `codec-abi-v1`. The ABI defines how JavaScript calls a WASM
module. Link format v1 identifies which immutable module receives the opaque bytes and converts the
resulting bitstring to fragment characters.

## Bit framing

A frame is MSB-first and carries an exact bit length. Significant bits in its last byte occupy the
high bits; unused low bits are zero. Dispatch headers are prefix-free:

| Header | Meaning |
|---|---|
| `10` | codec ID 1, the frozen GRU-L release |
| `1100` | literal UTF-8 payload |
| `1101` | reserved for a future framing extension |
| `111` + Elias gamma `(codecId - 1)` | codec IDs 2 and above |

The codec payload begins on the very next bit. It is not padded to a byte boundary, and no length
field is needed. Because every valid frame starts with `1`, its positive integer representation
preserves the exact bit length as well as leading zero bytes inside an opaque codec payload.

## Fragment rendering

The complete framed bitstring is interpreted as a positive integer and converted to this base-81
alphabet:

```text
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._~!$&'()*+,;=:@/?
```

These characters survive standards-compliant fragment parsing literally; `%` and `#` are excluded
because they have transport syntax. The inverse base conversion recovers the integer's minimal
binary representation, after which the prefix is parsed and the remaining whole bytes are passed
unchanged to the selected codec.

Codec IDs are not model metadata. Once an ID appears in a public link, its WASM and byte format are
immutable. Unknown IDs fail rather than falling back to another decoder.

## Frozen codec ID 1

Codec ID 1 is GRU-L implementing `codec-abi-v1`:

```text
artifact: codecs/artifacts/gru-l.wasm
SHA-256: f5442634407f76cc28e7494a17343e84b0c96feb4d92170186dffd1d27d8c79b
```

`npm run codec:release:verify` checks the published artifact against that digest. Both the normal
TypeScript build and the neural-codec build run the same release gate. The neural build hashes its
candidate before replacing the published file, so a compiler, source, weight, or flag change cannot
silently overwrite v1.

`codecs/releases/v1-fixtures.json` freezes raw WASM payloads, rendered fragments, and complete
display links. Compatibility tests reproduce all three layers. There is deliberately no checksum
inside each link: exact encode/decode verification protects link creation, while the immutable
artifact digest prevents decoder substitution.
