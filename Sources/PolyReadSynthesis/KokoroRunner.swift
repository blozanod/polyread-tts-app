import Foundation
import CoreML
import PolyReadCore
import PolyReadLinguistics

/// Tensor names for the two packages, kept in one place.
///
/// ─── INTEGRATION POINT (2 of 2) ─────────────────────────────────────────────
/// These come from §7.1's shape table. The app drives Core ML through `MLModel`
/// and `MLDictionaryFeatureProvider` rather than Xcode's generated classes, so a
/// name that turns out to be different is a one-line fix here instead of a
/// regenerate-and-rewrite. `KokoroModels.describeInterfaces()` prints what the
/// packages actually declare; the §0 benchmark screen shows it.
/// ────────────────────────────────────────────────────────────────────────────
public enum KokoroIO {
    public enum Prosody {
        public static let tokens = "tokens"
        public static let style = "style"
        public static let prosody = "prosody"
        public static let text = "text"
        public static let duration = "duration"
    }
    public enum Acoustic {
        public static let prosody = "prosody"
        public static let text = "text"
        public static let style = "style"
        public static let audio = "audio"
    }
    /// §7.1 — `prosody [1, 640, T]`, `text [1, 512, T]`.
    public static let prosodyChannels = 640
    public static let textChannels = 512
    public static let styleDimension = 256
}

public struct KokoroModels: Sendable {
    public let prosody: MLModel
    public let acoustic: MLModel
    public let acousticComputeUnits: MLComputeUnits

    /// §7.1 — "Set compute units per package. Prosody on `.cpuOnly` — the default
    /// placement runs it 5.6× slower. Acoustic per the §0 benchmark."
    ///
    /// §0.2 is the question of whether acoustic runs at all with `.cpuOnly`. The
    /// answer decides §7.3 wholesale: CPU-only means Phase B submits no Metal
    /// work, so it keeps rendering while backgrounded and the buffering problem
    /// disappears. Stored as a setting, defaulted to `.all` until measured.
    public static func load(
        bundle: Bundle = .main,
        acousticComputeUnits: MLComputeUnits = .all
    ) throws -> KokoroModels {
        let prosodyConfiguration = MLModelConfiguration()
        prosodyConfiguration.computeUnits = .cpuOnly

        let acousticConfiguration = MLModelConfiguration()
        acousticConfiguration.computeUnits = acousticComputeUnits

        return KokoroModels(
            prosody: try loadModel(named: "KokoroProsody", bundle: bundle, configuration: prosodyConfiguration),
            acoustic: try loadModel(named: "KokoroAcoustic", bundle: bundle, configuration: acousticConfiguration),
            acousticComputeUnits: acousticComputeUnits
        )
    }

    static func loadModel(named name: String, bundle: Bundle, configuration: MLModelConfiguration) throws -> MLModel {
        // Xcode compiles a bundled .mlpackage to .mlmodelc at build time; a
        // package dropped in by hand has to be compiled once at launch.
        if let compiled = bundle.url(forResource: name, withExtension: "mlmodelc") {
            return try MLModel(contentsOf: compiled, configuration: configuration)
        }
        if let package = bundle.url(forResource: name, withExtension: "mlpackage") {
            let compiled = try MLModel.compileModel(at: package)
            return try MLModel(contentsOf: compiled, configuration: configuration)
        }
        throw PolyReadError.modelMissing(name)
    }

    /// What the packages actually declare, for the §0 report.
    public func describeInterfaces() -> String {
        func describe(_ model: MLModel, _ label: String) -> String {
            let description = model.modelDescription
            let inputs = description.inputDescriptionsByName.map { name, value in
                "  in  \(name): \(value.multiArrayConstraint.map { "\($0.shape) \($0.dataType.rawValue)" } ?? "\(value.type.rawValue)")"
            }.sorted()
            let outputs = description.outputDescriptionsByName.map { name, value in
                "  out \(name): \(value.multiArrayConstraint.map { "\($0.shape) \($0.dataType.rawValue)" } ?? "\(value.type.rawValue)")"
            }.sorted()
            return ([label] + inputs + outputs).joined(separator: "\n")
        }
        return describe(prosody, "KokoroProsody") + "\n" + describe(acoustic, "KokoroAcoustic")
    }
}

/// One synthesis pass over one chunk.
public struct KokoroRunner: Sendable {

    let models: KokoroModels
    let voices: VoicesBin
    let voiceName: String

    public init(models: KokoroModels, voices: VoicesBin, voiceName: String) {
        self.models = models
        self.voices = voices
        self.voiceName = voiceName
    }

    // MARK: Phase A — durations only

    /// §7.2 — "run `KokoroProsody` on every chunk including footnote bodies, keep
    /// **only** `ChunkTiming.frameDurations`. Discard `prosody` and `text`."
    ///
    /// Retaining them would be ~2.3 MB per 510-phoneme chunk, several hundred MB
    /// across a long document, which jetsams a phone. The re-run in Phase B costs
    /// ~14%, and prosody is ~7× cheaper than acoustic, so it is the cheap half of
    /// the cheap half.
    public func durations(for chunk: PhonemizedChunk) throws -> ChunkTiming {
        let output = try runProsody(chunk: chunk, keepingTensors: false)
        return ChunkTiming(chunkID: chunk.id, frameDurations: output.frameDurations)
    }

    // MARK: Phase B — full render

    /// §7.3 — "`KokoroProsody` → gather → `KokoroAcoustic`".
    public func render(chunk: PhonemizedChunk) throws -> (samples: [Float], timing: ChunkTiming) {
        let prosodyOutput = try runProsody(chunk: chunk, keepingTensors: true)
        guard let prosody = prosodyOutput.prosody, let text = prosodyOutput.text else {
            throw PolyReadError.modelShapeMismatch("prosody run returned no tensors")
        }

        let frames = prosodyOutput.frameDurations
        let gatheredProsody = try Gather.expand(
            prosody,
            channels: KokoroIO.prosodyChannels,
            frameDurations: frames
        )
        let gatheredText = try Gather.expand(
            text,
            channels: KokoroIO.textChannels,
            frameDurations: frames
        )

        let style = try styleVector(for: chunk)
        let input = try MLDictionaryFeatureProvider(dictionary: [
            KokoroIO.Acoustic.prosody: MLFeatureValue(multiArray: gatheredProsody),
            KokoroIO.Acoustic.text: MLFeatureValue(multiArray: gatheredText),
            KokoroIO.Acoustic.style: MLFeatureValue(multiArray: style),
        ])

        let result = try models.acoustic.prediction(from: input)
        guard let audio = result.featureValue(for: KokoroIO.Acoustic.audio)?.multiArrayValue else {
            throw PolyReadError.modelShapeMismatch("acoustic returned no \"\(KokoroIO.Acoustic.audio)\"")
        }

        return (MultiArray.floats(audio), ChunkTiming(chunkID: chunk.id, frameDurations: frames))
    }

    // MARK: Prosody

    struct ProsodyOutput {
        let frameDurations: [Int]
        let prosody: MLMultiArray?
        let text: MLMultiArray?
    }

    func runProsody(chunk: PhonemizedChunk, keepingTensors: Bool) throws -> ProsodyOutput {
        // §7.1 — "Token 0 at both ends."
        let framed = KokoroVocabulary.framed(chunk.tokens)
        let tokens = try MultiArray.int32(framed, shape: [1, NSNumber(value: framed.count)])
        let style = try styleVector(for: chunk)

        let input = try MLDictionaryFeatureProvider(dictionary: [
            KokoroIO.Prosody.tokens: MLFeatureValue(multiArray: tokens),
            KokoroIO.Prosody.style: MLFeatureValue(multiArray: style),
        ])
        let result = try models.prosody.prediction(from: input)

        guard let duration = result.featureValue(for: KokoroIO.Prosody.duration)?.multiArrayValue else {
            throw PolyReadError.modelShapeMismatch("prosody returned no \"\(KokoroIO.Prosody.duration)\"")
        }

        // §3 — "round to at least 1 before the gather, and use the *rounded*
        // values for timing so audio and timeline agree exactly."
        let frames = FrameMath.roundedFrames(MultiArray.floats(duration))

        guard !keepingTensors else {
            return ProsodyOutput(
                frameDurations: frames,
                prosody: result.featureValue(for: KokoroIO.Prosody.prosody)?.multiArrayValue,
                text: result.featureValue(for: KokoroIO.Prosody.text)?.multiArrayValue
            )
        }
        return ProsodyOutput(frameDurations: frames, prosody: nil, text: nil)
    }

    /// §7.1 — "Style row index = phoneme count excluding the two boundary tokens."
    func styleVector(for chunk: PhonemizedChunk) throws -> MLMultiArray {
        let values = try voices.style(voice: voiceName, phonemeCount: chunk.tokens.count)
        return try MultiArray.float32(values, shape: [1, NSNumber(value: values.count)])
    }
}

/// §7.1 — "Caller gather: repeat column *i* of `prosody` and `text`
/// `round(duration[i])` times. `F` = sum of rounded durations."
public enum Gather {

    public static func expand(
        _ source: MLMultiArray,
        channels: Int,
        frameDurations: [Int]
    ) throws -> MLMultiArray {
        let shape = source.shape.map(\.intValue)
        guard shape.count == 3, shape[1] == channels else {
            throw PolyReadError.modelShapeMismatch("expected [1, \(channels), T], got \(shape)")
        }
        let sourceLength = shape[2]
        guard frameDurations.count == sourceLength else {
            throw PolyReadError.modelShapeMismatch(
                "duration has \(frameDurations.count) entries but tensor has \(sourceLength) columns"
            )
        }

        let frameCount = frameDurations.reduce(0, +)
        let destination = try MLMultiArray(
            shape: [1, NSNumber(value: channels), NSNumber(value: frameCount)],
            dataType: .float32
        )

        // Precompute the source column for each output frame once, rather than
        // once per channel.
        var columnForFrame = [Int](repeating: 0, count: frameCount)
        var cursor = 0
        for (column, repeats) in frameDurations.enumerated() {
            for _ in 0..<repeats {
                columnForFrame[cursor] = column
                cursor += 1
            }
        }

        let sourceStrides = source.strides.map(\.intValue)
        let destinationStrides = destination.strides.map(\.intValue)

        source.withUnsafeBufferPointer(ofType: Float.self) { input in
            destination.withUnsafeMutableBufferPointer(ofType: Float.self) { output, _ in
                // Channel-major so the writes are sequential.
                for channel in 0..<channels {
                    let sourceBase = channel * sourceStrides[1]
                    let destinationBase = channel * destinationStrides[1]
                    for frame in 0..<frameCount {
                        output[destinationBase + frame * destinationStrides[2]] =
                            input[sourceBase + columnForFrame[frame] * sourceStrides[2]]
                    }
                }
            }
        }
        return destination
    }
}

enum MultiArray {
    static func int32(_ values: [Int32], shape: [NSNumber]) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: shape, dataType: .int32)
        array.withUnsafeMutableBufferPointer(ofType: Int32.self) { buffer, _ in
            for (i, value) in values.enumerated() { buffer[i] = value }
        }
        return array
    }

    static func float32(_ values: [Float], shape: [NSNumber]) throws -> MLMultiArray {
        let array = try MLMultiArray(shape: shape, dataType: .float32)
        array.withUnsafeMutableBufferPointer(ofType: Float.self) { buffer, _ in
            for (i, value) in values.enumerated() { buffer[i] = value }
        }
        return array
    }

    static func floats(_ array: MLMultiArray) -> [Float] {
        var out = [Float](repeating: 0, count: array.count)
        switch array.dataType {
        case .float32:
            array.withUnsafeBufferPointer(ofType: Float.self) { buffer in
                for i in 0..<array.count { out[i] = buffer[i] }
            }
        case .double:
            array.withUnsafeBufferPointer(ofType: Double.self) { buffer in
                for i in 0..<array.count { out[i] = Float(buffer[i]) }
            }
        case .float16:
            // No direct Swift type; go through NSNumber rather than guess a layout.
            for i in 0..<array.count { out[i] = array[i].floatValue }
        default:
            for i in 0..<array.count { out[i] = array[i].floatValue }
        }
        return out
    }
}
