import Foundation
import CoreML
import PolyReadCore
import PolyReadLinguistics

/// Agent C's scheduler — §7.2 Phase A, §7.3 Phase B, and the on-demand render
/// that makes seeking ahead of the buffer edge work.
public actor SynthesisCoordinator {

    public struct Configuration: Sendable {
        /// §7.1 — "**Voice:** hardcode one for v1. Picker is v1.1."
        public var voiceName: String
        /// §0.2 — the gate question. `.cpuOnly` makes §7.3's whole buffering
        /// problem disappear, because a backgrounded app may not submit Metal
        /// work but may absolutely keep burning CPU.
        public var acousticComputeUnits: MLComputeUnits
        /// §7.3 — "Dismiss the loading bar when Phase A completes and ~60 s of
        /// audio exists."
        public var initialAudioLead: TimeInterval

        public init(
            voiceName: String = "af_heart",
            acousticComputeUnits: MLComputeUnits = .all,
            initialAudioLead: TimeInterval = 60
        ) {
            self.voiceName = voiceName
            self.acousticComputeUnits = acousticComputeUnits
            self.initialAudioLead = initialAudioLead
        }
    }

    public enum Phase: Sendable, Equatable {
        case idle
        case loadingModels
        case phaseA(chunksDone: Int, chunksTotal: Int)
        case primingAudio(seconds: TimeInterval, target: TimeInterval)
        case ready
        case failed(String)
    }

    public struct PhaseAResult: Sendable {
        public let words: [WordTiming]
        public let footnoteTimelines: [UUID: [WordTiming]]
        public let layout: StreamLayout
        public let duration: TimeInterval
    }

    let configuration: Configuration
    let runner: KokoroRunner
    private var timings: [UUID: ChunkTiming] = [:]
    private var layout: StreamLayout?
    private var writer: CAFWriter?
    private var outputURL: URL?
    private(set) public var progress = RenderProgress()

    public init(configuration: Configuration, bundle: Bundle = .main) throws {
        self.configuration = configuration
        let models = try KokoroModels.load(
            bundle: bundle,
            acousticComputeUnits: configuration.acousticComputeUnits
        )
        let voices = try VoicesBin.bundled(bundle: bundle)
        let voiceName = voices.names.contains(configuration.voiceName)
            ? configuration.voiceName
            // Rather than fail the whole import over a voice name, take the first
            // one the file actually has and let §7.1's "hardcode one" stand.
            : (voices.names.first ?? configuration.voiceName)
        self.runner = KokoroRunner(models: models, voices: voices, voiceName: voiceName)
    }

    /// Test seam: lets §0's benchmark and the unit tests drive the phases with a
    /// pre-built runner.
    public init(configuration: Configuration, runner: KokoroRunner) {
        self.configuration = configuration
        self.runner = runner
    }

    // MARK: - §7.2 Phase A

    /// "G2P the whole document, run `KokoroProsody` on every chunk including
    /// footnote bodies, keep **only** `ChunkTiming.frameDurations`."
    ///
    /// The output is "the complete `[WordTiming]` for the document: exact total
    /// duration, working scrubber, complete highlight map, correct seek — **with
    /// no audio generated**."
    public func runPhaseA(
        mainChunks: [PhonemizedChunk],
        footnoteChunks: [UUID: [PhonemizedChunk]],
        blocks: [Block],
        onProgress: (@Sendable (Int, Int) -> Void)? = nil
    ) throws -> PhaseAResult {
        let footnoteFlat = footnoteChunks.values.flatMap { $0 }
        let total = mainChunks.count + footnoteFlat.count
        var done = 0

        for chunk in mainChunks + footnoteFlat {
            timings[chunk.id] = try runner.durations(for: chunk)
            done += 1
            onProgress?(done, total)
        }

        let layout = StreamLayout(chunks: mainChunks, timings: timings, blocks: blocks)
        self.layout = layout

        let words = TimelineBuilder.build(layout: layout, timings: timings, blocks: blocks)

        // §4.5 — footnote bodies get their own timelines so §8.5 can interject
        // without the main timeline position moving.
        var footnoteTimelines: [UUID: [WordTiming]] = [:]
        for (blockID, chunks) in footnoteChunks {
            let noteLayout = StreamLayout(chunks: chunks, timings: timings, blocks: blocks)
            footnoteTimelines[blockID] = TimelineBuilder.build(
                layout: noteLayout,
                timings: timings,
                blocks: blocks
            )
        }

        progress = RenderProgress(
            renderedChunks: [],
            totalChunks: layout.entries.count,
            chunkFrameOffsets: layout.chunkFrameOffsets
        )

        return PhaseAResult(
            words: words,
            footnoteTimelines: footnoteTimelines,
            layout: layout,
            duration: layout.duration
        )
    }

    // MARK: - §7.3 Phase B

    public func prepareOutput(url: URL, resuming existing: RenderProgress?) throws {
        guard let layout else { throw PolyReadError.modelShapeMismatch("Phase A has not run") }
        outputURL = url
        writer = try CAFWriter(url: url, totalFrames: layout.totalFrames)
        if let existing, existing.chunkFrameOffsets == layout.chunkFrameOffsets {
            progress.renderedChunks = existing.renderedChunks
        }
    }

    /// "chunk by chunk in document order, appended to an Int16 CAF on disk.
    /// Never throttled."
    ///
    /// `onChunk` fires after every write so the §7.3 buffer edge on the scrubber
    /// moves live. Cancellation is cooperative: `Task.checkCancellation` between
    /// chunks, so closing a document does not wait out a whole acoustic pass.
    public func runPhaseB(
        onChunk: (@Sendable (RenderProgress) -> Void)? = nil
    ) async throws {
        guard let layout, let writer else {
            throw PolyReadError.modelShapeMismatch("Phase B started before prepareOutput")
        }

        for (index, entry) in layout.entries.enumerated() {
            try Task.checkCancellation()
            guard !progress.renderedChunks.contains(index) else { continue }
            try renderAndWrite(entry: entry, index: index, writer: writer)
            onChunk?(progress)
        }
        try writer.close()
        self.writer = nil
    }

    /// §7.3 — "**Seek into unrendered territory** is supported: Phase A already
    /// knows the word index at every timestamp, so render that chunk on demand
    /// (~one acoustic pass) and start there. Do not disable seeking ahead of the
    /// buffer edge."
    ///
    /// Possible only because the CAF was created at full length: the chunk goes
    /// straight to its own offset, out of order, and Phase B is none the wiser.
    @discardableResult
    public func renderOnDemand(chunkIndex index: Int) throws -> Bool {
        guard let layout, index >= 0, index < layout.entries.count else { return false }
        guard !progress.renderedChunks.contains(index) else { return true }

        // Phase B may have finished and closed the file; reopen it for the one
        // write rather than keeping a handle alive for the life of the document.
        let opened: CAFWriter
        if let existing = self.writer {
            opened = existing
        } else {
            guard let url = outputURL else {
                throw PolyReadError.cacheWriteFailed("no output file; call prepareOutput first")
            }
            opened = try CAFWriter(url: url, totalFrames: layout.totalFrames)
        }

        try renderAndWrite(entry: layout.entries[index], index: index, writer: opened)
        if self.writer == nil { try opened.close() }
        return true
    }

    private func renderAndWrite(entry: StreamLayout.Entry, index: Int, writer: CAFWriter) throws {
        let (samples, timing) = try runner.render(chunk: entry.chunk)

        // Phase A's rounded durations are the contract (§3: "use the *rounded*
        // values for timing so audio and timeline agree exactly"). If the re-run
        // in Phase B lands on different durations the audio is the wrong length
        // for the slot Phase A reserved, so trim or pad rather than let it slide
        // into the next chunk's frames.
        let expected = FrameMath.samples(frames: entry.frameCount)
        var adjusted = samples
        if adjusted.count > expected {
            adjusted = Array(adjusted[0..<expected])
        } else if adjusted.count < expected {
            adjusted.append(contentsOf: [Float](repeating: 0, count: expected - adjusted.count))
        }
        assert(
            timing.frameCount == entry.frameCount,
            "Phase B re-run produced \(timing.frameCount) frames where Phase A said \(entry.frameCount)"
        )

        // The leading silence is already zeros: the file was created at full
        // length and unwritten regions read as silence, so there is nothing to
        // write for a pause.
        try writer.write(samples: adjusted, atFrame: entry.startFrame)
        progress.renderedChunks.insert(index)
    }

    /// §8.5 — a footnote body renders to its own file. The main CAF's layout was
    /// fixed by Phase A and has no room for a note in it; a side file keeps the
    /// main timeline position from moving, which is the one thing §8.5 insists on.
    public func renderFootnote(chunks: [PhonemizedChunk], blocks: [Block], to url: URL) throws {
        let layout = StreamLayout(chunks: chunks, timings: timings, blocks: blocks)
        let writer = try CAFWriter(url: url, totalFrames: layout.totalFrames)
        defer { try? writer.close() }
        for entry in layout.entries {
            let (samples, _) = try runner.render(chunk: entry.chunk)
            try writer.write(samples: samples, atFrame: entry.startFrame)
        }
    }

    /// Rebuilds the Phase A state from a cached sidecar so an interrupted Phase B
    /// can pick up where it stopped. §7.2's prosody pass is cheap but not free,
    /// and re-running it would also risk landing on different rounded durations
    /// than the audio already on disk was written against.
    public func restore(
        mainChunks: [PhonemizedChunk],
        footnoteChunks: [UUID: [PhonemizedChunk]],
        chunkTimings: [ChunkTiming],
        blocks: [Block]
    ) {
        timings = [:]
        for timing in chunkTimings { timings[timing.chunkID] = timing }
        let layout = StreamLayout(chunks: mainChunks, timings: timings, blocks: blocks)
        self.layout = layout
        progress = RenderProgress(
            renderedChunks: [],
            totalChunks: layout.entries.count,
            chunkFrameOffsets: layout.chunkFrameOffsets
        )
    }

    /// Everything Phase A computed, for the sidecar.
    public func allChunkTimings() -> [ChunkTiming] { Array(timings.values) }

    public func currentProgress() -> RenderProgress { progress }

    public func streamLayout() -> StreamLayout? { layout }
}
