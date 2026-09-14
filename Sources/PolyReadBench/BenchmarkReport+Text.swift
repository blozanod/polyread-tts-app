import Foundation

extension BenchmarkReport {

    /// §0 — "Report all three before proceeding." This is that report, shaped so
    /// it can be pasted straight back into the conversation that asked for it.
    public var plainText: String {
        var lines: [String] = []
        lines.append("PolyRead §0 gate — \(device), iOS \(systemVersion)")
        lines.append(String(repeating: "=", count: 56))
        lines.append("")

        lines.append("§0.1 Acoustic throughput")
        if acoustic.isEmpty {
            lines.append("  not measured — the packages did not load")
        }
        for entry in acoustic {
            if entry.succeeded {
                let name = entry.computeUnits.padding(toLength: 20, withPad: " ", startingAt: 0)
                lines.append(
                    "  " + name + String(
                        format: "%6.2f× realtime  (%.1fs audio in %.1fs)",
                        entry.realtimeMultiple,
                        entry.audioSeconds,
                        entry.wallSeconds
                    )
                )
            } else {
                lines.append("  \(entry.computeUnits): FAILED — \(entry.failure ?? "unknown")")
            }
        }
        if let prosody {
            lines.append(
                String(format: "  prosody: %.1f ms/chunk over %d chunks", prosody.millisecondsPerChunk, prosody.chunks)
            )
        }
        lines.append(String(format: "  both packages loaded in %.2fs", loadSeconds))
        lines.append("")

        lines.append("§0.2 Does KokoroAcoustic run with .cpuOnly?")
        lines.append("  \(acousticRunsCPUOnly ? "YES" : "NO")")
        if let recommendedPlacement {
            lines.append("  fastest placement: \(recommendedPlacement)")
        }
        lines.append("")

        lines.append("§0.3 Does the phonemizer expose per-word phoneme grouping?")
        lines.append("  backend: \(phonemizer.backend)")
        lines.append("  per-word grouping: \(phonemizer.providesWordGrouping ? "YES" : "NO")")
        lines.append("  resolves homographs itself: \(phonemizer.resolvesHomographs ? "YES" : "NO")")
        if let failure = phonemizer.failure {
            lines.append("  failure: \(failure)")
        }
        for (word, phonemes) in zip(phonemizer.sampleWords, phonemizer.samplePhonemes) {
            lines.append("    \(word.padding(toLength: 14, withPad: " ", startingAt: 0)) \(phonemes)")
        }
        lines.append("")

        lines.append("Vocabulary")
        lines.append("  source: \(vocabulary.source)")
        lines.append("  symbols: \(vocabulary.symbolCount)")
        if !vocabulary.unencodableHomographs.isEmpty {
            lines.append("  unencodable homograph entries:")
            for entry in vocabulary.unencodableHomographs { lines.append("    \(entry)") }
        }
        lines.append("")

        if !voices.isEmpty {
            lines.append("Voices.bin: \(voices.count) voices — \(voices.prefix(8).joined(separator: ", "))")
            lines.append("")
        }

        if !modelInterfaces.isEmpty {
            lines.append("Declared model interfaces")
            lines.append(modelInterfaces)
            lines.append("")
        }

        if !notes.isEmpty {
            lines.append("Notes")
            for note in notes { lines.append("  • \(note)") }
        }

        return lines.joined(separator: "\n")
    }
}
