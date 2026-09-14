import Foundation
import CoreML
import PolyReadCore
import PolyReadLinguistics
import PolyReadSynthesis

/// §0 — "Gate: benchmark before writing app code. Three measurements on a real
/// iPhone and a real iPad. Do not scaffold the app first. The answers change §7
/// and §10. Report all three before proceeding."
///
/// This is the harness for those three questions. It exists as a runnable screen
/// rather than as a document because two of the three answers are empirical and
/// the third is a property of a package that may not be linked yet.
public struct BenchmarkReport: Sendable, Codable {

    public struct Acoustic: Sendable, Codable {
        public let computeUnits: String
        public let succeeded: Bool
        public let failure: String?
        public let audioSeconds: Double
        public let wallSeconds: Double
        /// §0.1 — "report the realtime multiple per device."
        public var realtimeMultiple: Double { wallSeconds > 0 ? audioSeconds / wallSeconds : 0 }
    }

    public struct Prosody: Sendable, Codable {
        public let chunks: Int
        public let wallSeconds: Double
        public var millisecondsPerChunk: Double {
            chunks > 0 ? wallSeconds * 1000 / Double(chunks) : 0
        }
    }

    public struct PhonemizerCheck: Sendable, Codable {
        public let backend: String
        /// §0.3 — the whole highlight mechanism.
        public let providesWordGrouping: Bool
        public let resolvesHomographs: Bool
        public let sampleWords: [String]
        public let samplePhonemes: [String]
        public let failure: String?
    }

    public struct Vocabulary: Sendable, Codable {
        public let source: String
        public let isVerified: Bool
        public let symbolCount: Int
        public let unencodableHomographs: [String]
    }

    public let device: String
    public let systemVersion: String
    public let modelInterfaces: String
    public let loadSeconds: Double
    public let prosody: Prosody?
    /// §0.2 — run at every placement, because the model card contradicts itself.
    public let acoustic: [Acoustic]
    public let phonemizer: PhonemizerCheck
    public let vocabulary: Vocabulary
    public let voices: [String]
    public let notes: [String]

    /// §0.2 — "iOS does not permit a backgrounded app to submit Metal work, so if
    /// acoustic runs CPU-only, Phase B keeps rendering while backgrounded and the
    /// entire buffering problem in §7.3 disappears."
    public var acousticRunsCPUOnly: Bool {
        acoustic.contains { $0.computeUnits == "cpuOnly" && $0.succeeded }
    }

    public var recommendedPlacement: String? {
        acoustic.filter(\.succeeded).max { $0.realtimeMultiple < $1.realtimeMultiple }?.computeUnits
    }
}

public struct BenchmarkRunner: Sendable {

    /// §0.1 — "synthesize 60 s of audio".
    public let targetAudioSeconds: Double

    public init(targetAudioSeconds: Double = 60) {
        self.targetAudioSeconds = targetAudioSeconds
    }

    public func run(
        bundle: Bundle = .main,
        voiceName: String = "af_heart",
        onProgress: @Sendable (String) -> Void = { _ in }
    ) async -> BenchmarkReport {
        var notes: [String] = []

        // ── §0.3 — does the phonemizer group phonemes per word? ───────────────
        onProgress("Checking the phonemizer (§0.3)")
        let phonemizerResult = checkPhonemizer()
        if !phonemizerResult.providesWordGrouping {
            notes.append(
                "§0.3 FAILED. Word-level highlighting is impossible without per-word "
                + "phoneme grouping. The spec is explicit: stop and raise it — that is a "
                + "module, not a patch."
            )
        }

        // ── Vocabulary sanity, which nothing else can be trusted without ──────
        let vocabulary = KokoroVocabulary.shared
        let unencodable = HomographResolver.unencodableEntries(using: vocabulary)
        if !vocabulary.isVerified {
            notes.append(
                "Kokoro vocabulary is the built-in reconstruction, not verified against "
                + "the shipped package. Drop kokoro_vocab.json into the bundle. A "
                + "vocabulary that is off by one produces fluent nonsense, not an error."
            )
        }
        if !unencodable.isEmpty {
            notes.append("\(unencodable.count) homograph entries use symbols outside the vocabulary.")
        }

        // ── Models ───────────────────────────────────────────────────────────
        var loadSeconds: Double = 0
        var interfaces = ""
        var voiceNames: [String] = []
        var prosodyResult: BenchmarkReport.Prosody?
        var acousticResults: [BenchmarkReport.Acoustic] = []

        let chunks = syntheticChunks(vocabulary: vocabulary)

        do {
            onProgress("Loading both packages (§7.1)")
            let start = Date()
            let models = try KokoroModels.load(bundle: bundle, acousticComputeUnits: .all)
            loadSeconds = Date().timeIntervalSince(start)
            interfaces = models.describeInterfaces()

            let voices = try VoicesBin.bundled(bundle: bundle)
            voiceNames = voices.names
            let voice = voices.names.contains(voiceName) ? voiceName : (voices.names.first ?? voiceName)

            // §7.1 — "Load both once at startup, ~0.35 s". Worth reporting: if it
            // is seconds rather than fractions, §7.1's "keep resident" matters more.
            if loadSeconds > 1.5 {
                notes.append(String(format: "Model load took %.2fs, well over §7.1's ~0.35 s.", loadSeconds))
            }

            // Prosody throughput, for §7.2's Phase A estimate.
            onProgress("Timing KokoroProsody (§7.2)")
            let prosodyRunner = KokoroRunner(models: models, voices: voices, voiceName: voice)
            let prosodyStart = Date()
            for chunk in chunks {
                _ = try prosodyRunner.durations(for: chunk)
            }
            prosodyResult = BenchmarkReport.Prosody(
                chunks: chunks.count,
                wallSeconds: Date().timeIntervalSince(prosodyStart)
            )

            // ── §0.1 and §0.2 together ───────────────────────────────────────
            for placement in [MLComputeUnits.all, .cpuAndNeuralEngine, .cpuOnly] {
                let label = Self.label(placement)
                onProgress("Timing KokoroAcoustic on \(label) (§0.1, §0.2)")
                acousticResults.append(
                    await measureAcoustic(
                        bundle: bundle,
                        voices: voices,
                        voiceName: voice,
                        placement: placement,
                        chunks: chunks
                    )
                )
            }
        } catch {
            notes.append("Could not run the model measurements: \(error.localizedDescription)")
        }

        // ── §0.2's consequence, spelled out ──────────────────────────────────
        if acousticResults.contains(where: { $0.computeUnits == "cpuOnly" && $0.succeeded }) {
            notes.append(
                "§0.2 ANSWERED: acoustic runs with .cpuOnly. Phase B submits no Metal work, "
                + "so it keeps rendering while backgrounded and §7.3's buffering problem "
                + "disappears. Set the placement to CPU only in Settings."
            )
        } else if !acousticResults.isEmpty {
            notes.append(
                "§0.2 ANSWERED: acoustic does NOT run with .cpuOnly. §7.3 applies as "
                + "written — buffer edge on the scrubber, play to the edge, and a "
                + "beginBackgroundTask extension when backgrounding with a thin lead."
            )
        }

        if let best = acousticResults.filter(\.succeeded).max(by: { $0.realtimeMultiple < $1.realtimeMultiple }),
           best.realtimeMultiple < 2 {
            notes.append(
                String(
                    format: "§0.1: best realtime multiple is %.1f×. Below about 2× Phase B "
                    + "cannot outrun playback and §7.3's 'the renderer laps the playhead "
                    + "within the first minute' does not hold on this device.",
                    best.realtimeMultiple
                )
            )
        }

        return BenchmarkReport(
            device: Self.deviceModel(),
            systemVersion: Self.systemVersion(),
            modelInterfaces: interfaces,
            loadSeconds: loadSeconds,
            prosody: prosodyResult,
            acoustic: acousticResults,
            phonemizer: phonemizerResult,
            vocabulary: BenchmarkReport.Vocabulary(
                source: vocabulary.source,
                isVerified: vocabulary.isVerified,
                symbolCount: vocabulary.symbolToID.count,
                unencodableHomographs: unencodable
            ),
            voices: voiceNames,
            notes: notes
        )
    }

    // MARK: - §0.1 / §0.2

    private func measureAcoustic(
        bundle: Bundle,
        voices: VoicesBin,
        voiceName: String,
        placement: MLComputeUnits,
        chunks: [PhonemizedChunk]
    ) async -> BenchmarkReport.Acoustic {
        do {
            let models = try KokoroModels.load(bundle: bundle, acousticComputeUnits: placement)
            let runner = KokoroRunner(models: models, voices: voices, voiceName: voiceName)

            // One warm-up pass: the first prediction after a placement change
            // pays for compilation and would swamp the measurement.
            _ = try runner.render(chunk: chunks[0])

            var audioSamples = 0
            let start = Date()
            var index = 0
            while Double(audioSamples) / FrameMath.sampleRate < targetAudioSeconds {
                let (samples, _) = try runner.render(chunk: chunks[index % chunks.count])
                audioSamples += samples.count
                index += 1
                // A device that cannot get there is a finding, not a hang.
                if index > chunks.count * 40 { break }
            }
            let wall = Date().timeIntervalSince(start)

            return BenchmarkReport.Acoustic(
                computeUnits: Self.label(placement),
                succeeded: true,
                failure: nil,
                audioSeconds: Double(audioSamples) / FrameMath.sampleRate,
                wallSeconds: wall
            )
        } catch {
            return BenchmarkReport.Acoustic(
                computeUnits: Self.label(placement),
                succeeded: false,
                failure: error.localizedDescription,
                audioSeconds: 0,
                wallSeconds: 0
            )
        }
    }

    // MARK: - §0.3

    func checkPhonemizer() -> BenchmarkReport.PhonemizerCheck {
        let phonemizer = PhonemizerFactory.make()
        // Homographs (§6.1) and a proper noun that will route to OOV.
        let words = [
            "The", "record", "shows", "Przeworski", "would", "record", "the", "vote",
            "in", "1993", "e.g.", "conflict",
        ]
        let tags = POSTagger().tag(tokens: words)

        do {
            let result = try phonemizer.phonemize(tokens: words, posTags: tags)
            let grouped = result.count == words.count
            return BenchmarkReport.PhonemizerCheck(
                backend: phonemizer.name,
                providesWordGrouping: grouped && phonemizer.capabilities.providesWordGrouping,
                resolvesHomographs: phonemizer.capabilities.resolvesHomographs,
                sampleWords: words,
                samplePhonemes: result.map(\.phonemes),
                failure: grouped ? nil : "returned \(result.count) groups for \(words.count) words"
            )
        } catch {
            return BenchmarkReport.PhonemizerCheck(
                backend: phonemizer.name,
                providesWordGrouping: false,
                resolvesHomographs: false,
                sampleWords: words,
                samplePhonemes: [],
                failure: error.localizedDescription
            )
        }
    }

    /// Chunks near the 510 budget, which is what §6.2 aims to emit, so the
    /// measurement reflects the shape of real work rather than a short utterance.
    func syntheticChunks(vocabulary: KokoroVocabulary) -> [PhonemizedChunk] {
        let phonemizer = FallbackPhonemizer()
        let sentence = """
        Comparative politics has long treated the consolidation of democratic \
        institutions as a function of economic development, but the evidence for \
        that relationship is considerably weaker than the literature suggests.
        """
        let words = sentence.split(separator: " ").map(String.init)
        let tags = POSTagger().tag(tokens: words)
        let phonemized = (try? phonemizer.phonemize(tokens: words, posTags: tags)) ?? []

        var tokens: [Int32] = []
        var ranges: [Range<Int>] = []
        let space = vocabulary.symbolToID[" "]
        var index = 0
        while tokens.count < Chunker.budget - 40, !phonemized.isEmpty {
            let word = phonemized[index % phonemized.count]
            if !tokens.isEmpty, let space { tokens.append(space) }
            let start = tokens.count
            tokens.append(contentsOf: vocabulary.encode(word.phonemes).tokens)
            ranges.append(start..<tokens.count)
            index += 1
        }

        let blockID = UUID()
        return (0..<3).map { _ in
            PhonemizedChunk(blockID: blockID, tokens: tokens, wordPhonemeRanges: ranges, spanOffset: 0)
        }
    }

    static func label(_ units: MLComputeUnits) -> String {
        switch units {
        case .cpuOnly: return "cpuOnly"
        case .cpuAndGPU: return "cpuAndGPU"
        case .all: return "all"
        case .cpuAndNeuralEngine: return "cpuAndNeuralEngine"
        @unknown default: return "unknown"
        }
    }

    static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        return machine
    }

    static func systemVersion() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }
}
