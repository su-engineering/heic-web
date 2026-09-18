# Security policy

This package parses untrusted, attacker-controlled binary input inside your
users' browsers. That is its whole job, so security reports are welcome and
taken seriously.

## Reporting a vulnerability

Email **hello@su.engineering** with `@su-engineering/heic` in the subject line.

Please include the file that triggers it if you can share one, or a script that
generates it. A reproducing input is worth more than a description.

Expect an acknowledgement within a few days. Please do not open a public issue
for anything that looks exploitable until a fix is out.

## Threat model

The input is hostile. The attacker controls every byte of the file. The attack
surface includes container parsing, decode planning, rendering, and the selected
browser or optional libheif codec. Upstream codecs are outside this repository,
but reports that help isolate a problem are welcome.

The parser and planner enforce these checks:

- **Binary reads are bounds-checked.** The `Reader` class validates its window
  before accessing the buffer. Specialized payload and codec parsers also use
  explicit bounds checks.
- **Box nesting is capped** at 32, and the number of sibling boxes at one level
  at 65,536. These bound the box walker's recursion and sibling iteration.
- **No allocation on a declared size** without validating it against the real
  buffer first. A malformed `extent_length` cannot trigger a 4 GB allocation; a
  64-bit box size above `Number.MAX_SAFE_INTEGER` is rejected rather than
  silently truncated.
- **Implausible dimensions are refused** before any canvas is created: 256
  megapixels total, and at most 4,096 grid tiles.
- **A grid whose declared rows × columns disagrees with its `dimg` reference
  list is rejected**, rather than decoded with a silently shifted mosaic.
- **File-supplied counts never drive an unbounded loop.** Every count that comes
  out of a box has a ceiling.
- **Essential properties we do not understand cause a failure**, not a
  confidently wrong image.

What it does not defend against:

- Bugs in the browser's own HEVC decoder or in libheif. Those are upstream.
- Resource exhaustion from a large valid image within the caps above.
  `maxDimension` scales the final result and does not cap peak decode memory.
  Enforce application input/dimension limits and bound concurrent decodes.

## This is a client-side decoder

Decoding a file here says nothing about whether it is safe to store, serve, or
trust. **Validate uploads on your server independently.** A file that decodes
cleanly in a browser can still be crafted to attack whatever handles it next.

## Testing

The parser is fuzzed against mutated real-world files on every run: byte flips,
truncation, hostile 32-bit size and count fields, zeroed runs, and spliced
regions. Every case must produce a typed `HeicError` rather than a crash, and
completed cases are checked against an elapsed-time budget. This synchronous
fuzzer does not interrupt an infinite loop; process-level CI timeouts remain
necessary.

## Supported versions

Security fixes target the latest released version. There is currently no
long-term support commitment for older releases. Use current browser and
optional codec versions, and update when a security fix is released.
