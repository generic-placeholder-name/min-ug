# min.ug core-WASM codec ABI v1

This document, not a runtime version function, defines ABI v1. A codec's immutable dispatcher
ID identifies the exact module and its encoded format. Link framing and codec IDs are outside
this ABI and are specified in [`link-format-v1.md`](link-format-v1.md).

The JavaScript adapter exposes the synchronous product interface:

```ts
interface Codec {
  encode(canonicalUrl: string): Uint8Array;
  decode(payload: Uint8Array): string;
}
```

Module compilation and loading may be asynchronous. Calls on an instantiated module are
synchronous. The canonicalizer runs before `encode`; a codec must treat its URL input as opaque
UTF-8 and must never parse, clean, normalize, reorder, or otherwise rewrite it.

## Module shape

The module has no imports and exports one unshared memory plus these four functions:

```text
memory:      WebAssembly.Memory
minug_alloc:  (length: i32) -> i32
minug_free:   (pointer: i32, length: i32) -> ()
minug_encode: (input_pointer: i32, input_length: i32, result_pointer: i32) -> i32
minug_decode: (input_pointer: i32, input_length: i32, result_pointer: i32) -> i32
```

Other non-function metadata exports are ignored. No `minug_codec_abi_version` export exists:
the ABI name is frozen here, while the dispatcher codec ID selects the exact immutable
implementation.

Shared memory is forbidden: codecs are deterministic, single-owner modules and the adapter
does not define concurrent access. All `i32` pointer and length values are interpreted as
unsigned 32-bit integers. Memory may grow during any call. The host must reacquire
`memory.buffer` and rebuild its views after each call into the module.

## Slices and descriptor

A slice is `{ pointer: u32, length: u32 }` into exported linear memory. Its canonical empty
representation is `{ 0, 0 }`; a nonempty slice must have a nonzero pointer and fit completely
inside current memory.

Before calling `encode` or `decode`, the host allocates an eight-byte, four-byte-aligned result
descriptor and zeroes it:

```text
offset  size  field
0       4     output pointer, little-endian u32
4       4     output length, little-endian u32
```

On success, the codec writes the output slice to this descriptor. The output must be a new,
module-owned allocation and must not overlap the host-owned input or descriptor. The host
copies the bytes out, then calls `minug_free(output_pointer, output_length)` exactly once.

The host owns input and descriptor allocations. A codec may read the input and write the
descriptor only for the duration of the call; it must not retain or free either one. After a
successful call or a declared codec error, the host frees its allocations in reverse order.

`minug_alloc(0)` is not called by the adapter. Allocation of a nonempty slice returns zero on
failure. `minug_free` receives the original pointer and byte length; `(0, 0)` is a no-op.

## Text and exactness

`encode` input is the canonical JavaScript URL encoded as strict UTF-8. `decode` output must
be strict UTF-8; malformed byte sequences are an ABI failure. No NUL terminator is present or
implied.

UTF-8 is the transport contract, not a promise that every codec accepts every UTF-8 string. The
current neural release accepts only the 91 single-byte symbols produced by canonical HTTP(S) URL
serialization and returns `INVALID_INPUT` for anything else. That narrower model domain belongs to
the codec release; the ABI also supports conformance codecs with broader domains.

For every canonical URL accepted by a shipped codec:

```text
decode(encode(canonicalUrl)) === canonicalUrl
```

The equality is JavaScript string equality after strict UTF-8 conversion. A codec is also
deterministic: the same module and input bytes produce the same payload bytes.

## Status values

`encode` and `decode` return one of:

| Value | Name | Meaning |
|---:|---|---|
| 0 | `OK` | Descriptor contains an owned output slice. |
| 1 | `INVALID_INPUT` | Input is outside this codec's accepted domain. |
| 2 | `MALFORMED_PAYLOAD` | Decode input is not a payload emitted by this codec. |
| 3 | `RESOURCE_LIMIT` | The operation cannot complete within codec resources. |
| 4 | `INTERNAL_ERROR` | The codec detected an internal failure. |

On every nonzero status, the descriptor remains `{ 0, 0 }` and the codec owns no output.
Known nonzero statuses do not invalidate the instance. Unknown statuses are ABI failures.

## Host validation and failure policy

Before exposing a module as a `Codec`, the adapter validates its imports, unshared memory,
required exports, function arities, and configured initial-memory limit. For every operation
it also enforces input, output, and memory limits with overflow-safe bounds checks.

A trap, malformed return value, unknown status, invalid or aliased slice, memory-limit breach,
or malformed decoded UTF-8 poisons the instance. The adapter never calls back into a poisoned
instance; its owner must discard it and instantiate a fresh copy. A normal input/output limit,
allocation failure, or declared status is reported without poisoning when ownership is still
well-defined.

Runtime limits detect a violation after a WASM call returns; they do not preempt infinite
execution or undo a large `memory.grow`. Published codecs are trusted, release-validated
artifacts. If modules ever become untrusted, execution also belongs in a terminable Worker or
process with stricter module-level limits.
