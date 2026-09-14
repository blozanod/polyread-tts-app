import Foundation
import SwiftUI
import UIKit
import PDFKit
import CoreML
import PolyReadCore
import PolyReadExtraction
import PolyReadLinguistics
import PolyReadSynthesis
import PolyReadPlayback

/// Drives one document from a PDF URL to a playing timeline, and owns the state
/// the §10 surfaces render.
@MainActor
public final class DocumentSession: ObservableObject {

    public enum Stage: Equatable {
        case idle
        /// §4.2 — "If Vision also scores badly, surface it in the import flow and
        /// let the user decide whether to continue."
        case awaitingOCRConfirmation(BackendDecisionSummary)
        case extracting(pagesDone: Int, pagesTotal: Int)
        case phonemizing
        /// §7.2 — the loading bar's real content.
        case phaseA(chunksDone: Int, chunksTotal: Int)
        /// §7.3 — "Dismiss the loading bar when Phase A completes and ~60 s of
        /// audio exists."
        case priming(seconds: TimeInterval, target: TimeInterval)
        case ready
        case failed(String)

        public var isLoading: Bool {
            switch self {
            case .ready, .idle, .failed, .awaitingOCRConfirmation: return false
            default: return true
            }
        }
    }

    public struct BackendDecisionSummary: Equatable, Sendable {
        public let embeddedScore: Double
        public let visionScore: Double?
        public let pageCount: Int
    }

    @Published public private(set) var stage: Stage = .idle
    @Published public private(set) var title: String = ""
    @Published public private(set) var reflow: ReflowDocument?
    @Published public private(set) var blocks: [Block] = []
    @Published public private(set) var pdf: PDFDocument?
    @Published public var settings = AppSettings.load()

    public let playback = PlaybackController()

    private var cache: DocumentCache?
    private var coordinator: SynthesisCoordinator?
    private var phaseBTask: Task<Void, Never>?
    private var pendingURL: URL?
    private var contentHash: String?
    private var footnoteChunks: [UUID: [PhonemizedChunk]] = [:]
    private var footnoteTimelines: [UUID: [WordTiming]] = [:]
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    public init() {
        cache = try? DocumentCache(byteLimit: settings.cacheByteLimit)
        playback.renderOnDemand = { [weak self] time in
            guard let self else { return false }
            return await self.renderOnDemand(at: time)
        }
        playback.prepareFootnote = { [weak self] blockID in
            guard let self else { return nil }
            return await self.prepareFootnote(blockID: blockID)
        }
    }

    // MARK: - Import

    public func open(url: URL) {
        pendingURL = url
        Task { await self.beginImport(url: url, confirmedLowConfidence: false) }
    }

    /// §4.2 — the user said "go ahead anyway".
    public func confirmLowConfidenceImport() {
        guard let url = pendingURL else { return }
        Task { await self.beginImport(url: url, confirmedLowConfidence: true) }
    }

    public func cancelImport() {
        pendingURL = nil
        stage = .idle
    }

    private func beginImport(url: URL, confirmedLowConfidence: Bool) async {
        // Security-scoped access: the picker hands back a URL outside the
        // sandbox, and reading it without this silently yields nothing.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        do {
            let hash = try DocumentCache.contentHash(of: url)
            contentHash = hash
            let document = PDFDocument(url: url)
            pdf = document
            try? cache?.storePDF(from: url, hash: hash)

            // §7.4 — "Keyed by PDF content hash so reopening a document is instant."
            if let cache, let sidecar = cache.sidecar(for: hash),
               sidecar.voiceName == settings.voiceName,
               FileManager.default.fileExists(atPath: cache.audioURL(for: hash).path) {
                try await resume(from: sidecar, hash: hash, cache: cache)
                return
            }

            let extractor = DocumentExtractor()
            let decision = try extractor.survey(url: url)
            if decision.needsUserConfirmation, !confirmedLowConfidence {
                stage = .awaitingOCRConfirmation(
                    BackendDecisionSummary(
                        embeddedScore: decision.embeddedQuality.score,
                        visionScore: decision.visionQuality?.score,
                        pageCount: document?.pageCount ?? 0
                    )
                )
                return
            }

            stage = .extracting(pagesDone: 0, pagesTotal: max(1, document?.pageCount ?? 1))
            let extraction = try await Task.detached(priority: .userInitiated) {
                try extractor.extract(url: url, decision: decision) { done, total in
                    Task { @MainActor in
                        self.stage = .extracting(pagesDone: done, pagesTotal: total)
                    }
                }
            }.value

            title = extraction.title
            stage = .phonemizing

            let pipeline = LinguisticsPipeline()
            let linguistics = try await Task.detached(priority: .userInitiated) {
                try pipeline.run(blocks: extraction.blocks)
            }.value

            blocks = linguistics.blocks
            reflow = linguistics.reflow
            footnoteChunks = linguistics.footnoteChunks

            try await runPhaseAAndStartB(
                linguistics: linguistics,
                hash: hash,
                title: extraction.title,
                pageCount: extraction.pageCount
            )
        } catch {
            stage = .failed(error.localizedDescription)
        }
    }

    // MARK: - §7.2 / §7.3

    private func runPhaseAAndStartB(
        linguistics: LinguisticsPipeline.Output,
        hash: String,
        title: String,
        pageCount: Int
    ) async throws {
        guard let cache else { throw PolyReadError.cacheWriteFailed("no cache directory") }

        let configuration = SynthesisCoordinator.Configuration(
            voiceName: settings.voiceName,
            acousticComputeUnits: settings.acousticComputeUnits.mlComputeUnits,
            initialAudioLead: settings.initialAudioLead
        )
        let coordinator = try SynthesisCoordinator(configuration: configuration)
        self.coordinator = coordinator

        stage = .phaseA(chunksDone: 0, chunksTotal: linguistics.mainChunks.count)

        let phaseA = try await coordinator.runPhaseA(
            mainChunks: linguistics.mainChunks,
            footnoteChunks: linguistics.footnoteChunks,
            blocks: linguistics.blocks
        ) { done, total in
            Task { @MainActor in self.stage = .phaseA(chunksDone: done, chunksTotal: total) }
        }

        footnoteTimelines = phaseA.footnoteTimelines

        // §7.4 — sidecar first, so an interrupted Phase B still reopens instantly
        // with a working scrubber and highlight map over silence.
        let sidecar = DocumentSidecar(
            contentHash: hash,
            title: title,
            pageCount: pageCount,
            voiceName: settings.voiceName,
            blocks: linguistics.blocks,
            words: phaseA.words,
            mainChunks: linguistics.mainChunks,
            footnoteChunks: linguistics.footnoteChunks,
            chunkTimings: await coordinator.allChunkTimings(),
            reflow: linguistics.reflow,
            footnoteTimelines: phaseA.footnoteTimelines
        )
        try cache.save(sidecar: sidecar)
        try cache.touch(
            hash: hash,
            title: title,
            pageCount: pageCount,
            duration: phaseA.duration,
            isComplete: false
        )
        try cache.evictIfNeeded(protecting: hash)

        let audioURL = cache.audioURL(for: hash)
        try await coordinator.prepareOutput(url: audioURL, resuming: cache.progress(for: hash))

        try playback.load(
            timeline: Timeline(words: phaseA.words),
            audioURL: audioURL,
            title: title,
            artwork: thumbnail(),
            renderedThrough: 0
        )

        stage = .priming(seconds: 0, target: settings.initialAudioLead)
        startPhaseB(hash: hash, totalDuration: phaseA.duration)
    }

    private func startPhaseB(hash: String, totalDuration: TimeInterval) {
        guard let coordinator, let cache else { return }
        phaseBTask?.cancel()
        phaseBTask = Task { [weak self] in
            do {
                try await coordinator.runPhaseB { progress in
                    Task { @MainActor in
                        self?.onPhaseBProgress(progress, hash: hash, totalDuration: totalDuration)
                    }
                }
                await MainActor.run {
                    try? cache.touch(
                        hash: hash,
                        title: self?.title ?? "",
                        pageCount: self?.pdf?.pageCount ?? 0,
                        duration: totalDuration,
                        isComplete: true
                    )
                }
            } catch is CancellationError {
                // Closing the document mid-render is normal; progress is on disk.
            } catch {
                await MainActor.run { self?.stage = .failed(error.localizedDescription) }
            }
        }
    }

    private func onPhaseBProgress(_ progress: RenderProgress, hash: String, totalDuration: TimeInterval) {
        try? cache?.save(progress: progress, for: hash)
        playback.updateRenderedEdge(progress.renderedThrough)

        if case .priming = stage {
            let lead = progress.renderedThrough
            // §7.3 — "Dismiss the loading bar when Phase A completes and ~60 s of
            // audio exists." Or when the whole document is shorter than that.
            if lead >= settings.initialAudioLead || progress.isComplete {
                stage = .ready
            } else {
                stage = .priming(seconds: lead, target: settings.initialAudioLead)
            }
        }
    }

    // MARK: - Resume from cache

    private func resume(from sidecar: DocumentSidecar, hash: String, cache: DocumentCache) async throws {
        title = sidecar.title
        blocks = sidecar.blocks
        reflow = sidecar.reflow
        footnoteTimelines = sidecar.footnoteTimelines

        let progress = cache.progress(for: hash) ?? RenderProgress()
        try playback.load(
            timeline: Timeline(words: sidecar.words),
            audioURL: cache.audioURL(for: hash),
            title: sidecar.title,
            artwork: thumbnail(),
            renderedThrough: progress.renderedThrough
        )
        try cache.touch(
            hash: hash,
            title: sidecar.title,
            pageCount: sidecar.pageCount,
            duration: sidecar.duration,
            isComplete: progress.isComplete
        )
        footnoteChunks = sidecar.footnoteChunks
        stage = .ready

        // A document rendered only halfway before the app was killed picks up
        // where it stopped rather than replaying what is already on disk.
        guard !progress.isComplete else { return }

        let configuration = SynthesisCoordinator.Configuration(
            voiceName: settings.voiceName,
            acousticComputeUnits: settings.acousticComputeUnits.mlComputeUnits,
            initialAudioLead: settings.initialAudioLead
        )
        let coordinator = try SynthesisCoordinator(configuration: configuration)
        self.coordinator = coordinator
        await coordinator.restore(
            mainChunks: sidecar.mainChunks,
            footnoteChunks: sidecar.footnoteChunks,
            chunkTimings: sidecar.chunkTimings,
            blocks: sidecar.blocks
        )
        try await coordinator.prepareOutput(url: cache.audioURL(for: hash), resuming: progress)
        startPhaseB(hash: hash, totalDuration: sidecar.duration)
    }

    // MARK: - §7.3 on-demand render, §8.5 footnotes

    private func renderOnDemand(at time: TimeInterval) async -> Bool {
        guard let coordinator else { return false }
        let progress = await coordinator.currentProgress()
        guard let index = progress.chunkIndex(at: time) else { return false }
        return (try? await coordinator.renderOnDemand(chunkIndex: index)) ?? false
    }

    /// §8.5 — renders one footnote body to its own file so the main CAF, whose
    /// layout Phase A fixed, is untouched.
    private func prepareFootnote(blockID: UUID) async -> (url: URL, words: [WordTiming])? {
        guard
            let coordinator,
            let cache,
            let hash = contentHash,
            let chunks = footnoteChunks[blockID],
            let words = footnoteTimelines[blockID],
            !chunks.isEmpty
        else { return nil }

        let url = cache.audioURL(for: hash)
            .deletingLastPathComponent()
            .appendingPathComponent("note-\(blockID.uuidString).caf")

        if FileManager.default.fileExists(atPath: url.path) {
            return (url, words)
        }
        do {
            try await coordinator.renderFootnote(chunks: chunks, blocks: blocks, to: url)
            return (url, words)
        } catch {
            return nil
        }
    }

    // MARK: - Lifecycle

    /// §7.3 — "If the app backgrounds with under ~2 minutes of lead, take a
    /// `beginBackgroundTask` extension to bank ~30 s more."
    ///
    /// Skipped entirely when acoustic runs CPU-only, because then Phase B keeps
    /// going anyway — §0.2, and the reason it is the gate question it is.
    public func applicationDidEnterBackground() {
        guard settings.acousticComputeUnits != .cpuOnly else { return }
        let lead = playback.renderedThrough - playback.position
        guard lead < 120, phaseBTask != nil, backgroundTask == .invalid else { return }

        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "PolyRead.PhaseB") { [weak self] in
            self?.endBackgroundTask()
        }
    }

    public func applicationWillEnterForeground() {
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    public func close() {
        phaseBTask?.cancel()
        phaseBTask = nil
        playback.unload()
        endBackgroundTask()
        stage = .idle
    }

    // MARK: - Library (§11: "no library beyond recently-opened")

    public func libraryEntries() -> [DocumentCache.Entry] {
        cache?.entries() ?? []
    }

    public func reopen(entry: DocumentCache.Entry) {
        guard let cache else { return }
        close()
        Task {
            do {
                guard let sidecar = cache.sidecar(for: entry.contentHash) else {
                    // Sidecar gone or written by an older pipeline: the PDF is
                    // still here, so re-import rather than dead-end.
                    self.open(url: cache.pdfURL(for: entry.contentHash))
                    return
                }
                self.contentHash = entry.contentHash
                self.pdf = PDFDocument(url: cache.pdfURL(for: entry.contentHash))
                try await self.resume(from: sidecar, hash: entry.contentHash, cache: cache)
            } catch {
                self.stage = .failed(error.localizedDescription)
            }
        }
    }

    public func forget(hash: String) {
        try? cache?.remove(hash: hash)
    }

    public func cacheBytes() -> Int {
        cache?.totalBytes() ?? 0
    }

    public func clearCache() {
        guard let cache else { return }
        for entry in cache.entries() where entry.contentHash != contentHash {
            try? cache.remove(hash: entry.contentHash)
        }
    }

    private func thumbnail() -> UIImage? {
        guard let page = pdf?.page(at: 0) else { return nil }
        return page.thumbnail(of: CGSize(width: 512, height: 512), for: .cropBox)
    }
}
