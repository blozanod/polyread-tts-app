# Drop the model files here

These are not in the repository — they are ~150 MB of weights and are not mine
to redistribute. The app looks for all four in its main bundle.

| File | Where from | §  |
|---|---|---|
| `KokoroProsody.mlpackage` | the Kokoro Core ML release | §7.1 |
| `KokoroAcoustic.mlpackage` | same | §7.1 |
| `Voices.bin` | same | §7.1 |
| `kokoro_vocab.json` | optional but strongly recommended — see below | §6.2 |

Add the first three to the Xcode target's **Copy Bundle Resources** phase.
Xcode compiles an `.mlpackage` to `.mlmodelc` at build time; `KokoroModels.load`
accepts either, and compiles at launch if it only finds the package.

## kokoro_vocab.json

A flat `{"symbol": id}` map of Kokoro's phoneme vocabulary.

`KokoroVocabulary` ships a **reconstruction** of that table which has not been
checked against the packages in this repository — there were none to check it
against. A vocabulary that is off by one does not fail; it produces confident,
fluent nonsense. So if the release includes a vocabulary file, convert it to this
shape and bundle it: `KokoroVocabulary.load` prefers it and the §0 benchmark
screen reports which one is in use.
