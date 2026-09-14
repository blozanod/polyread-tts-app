# tools

Stand-ins for a compiler. Nothing in this repository has been built: there was
no Swift toolchain in the environment it was written in, and
`download.swift.org` is blocked by that environment's egress policy.

These catch a real but limited class of problem. **They are not a substitute for
`swift build`** — run that first thing.

| | |
|---|---|
| `swiftcheck.py` | Delimiter balance, smart quotes in code, and duplicate keys in dictionary literals — which trap at *runtime* in Swift rather than failing the build, so they are invisible until the line executes. |
| `xref.py` | Indexes every member of every type declared in the package, then checks each `Type.member` reference against it. Catches renames and typos across module boundaries. |

The three `*_sim.py` files are faithful Python ports of the algorithms that are
easiest to get subtly wrong, run against the same cases as the Swift tests plus
a brute-force reference:

| | Verifies |
|---|---|
| `g2p_sim.py` | The §6.1 fallback rule engine and stress assignment. Parses the rule table straight out of `FallbackLexicon.swift`, so it cannot drift from it. |
| `chunker_sim.py` | §6.2 — the 510-phoneme budget, uniform chunk lengths, sentence backoff, abbreviation handling, and termination on a pathological token. |
| `timeline_sim.py` | §8.3's cursor-cached galloping search, against `bisect`, over monotonic, reverse, random-scrub and exact-boundary access patterns. |

Run them from the repository root:

```
python3 tools/swiftcheck.py Sources && python3 tools/swiftcheck.py Tests
python3 tools/xref.py Sources Tests
python3 tools/g2p_sim.py && python3 tools/chunker_sim.py && python3 tools/timeline_sim.py
```

They parse the Swift sources for their tables, so they stay honest as the Swift
changes. Delete them once the project builds and `swift test` runs — at that
point they are strictly worse than the real thing.
