import Foundation
import AVFoundation
import UIKit
import Combine
import PolyReadCore

/// §8 — transport, highlight sync, and the §8.5 footnote branch.
///
/// The published `wordIndex` is, per §10, "one piece of state; the two views are
/// renderers of it."
@MainActor
public final class PlaybackController: ObservableObject {

    // MARK: Published state

    @Published public private(set) var wordIndex: Int?
    @Published public private(set) var position: TimeInterval = 0
    @Published public private(set) var isPlaying = false
    /// §7.3 — "Show the rendered-through edge on the scrubber permanently, like a
    /// video preload bar. Most of the time it sits pinned at the end."
    @Published public private(set) var renderedThrough: TimeInterval = 0
    @Published public private(set) var footnote: FootnoteState?
    @Published public var rate: Float = 1.0 {
        didSet { engine.rate = rate }
    }

    /// §8.5 — "A state-machine branch, not a free feature. The main timeline
    /// position must not move."
    public struct FootnoteState: Equatable {
        public let blockID: UUID
        public let resumeAt: TimeInterval
        public var wordIndex: Int?
    }

    // MARK: Collaborators

    public let engine = AudioEngine()
    public let session = AudioSessionManager()
    public let nowPlaying = NowPlayingController()

    public private(set) var timeline: Timeline
    private var displayLink: CADisplayLink?
    private var scheduledThrough: TimeInterval = 0
    private var wasPlayingBeforeInterruption = false

    /// Renders a chunk that is not on disk yet. §7.3 — "Do not disable seeking
    /// ahead of the buffer edge."
    public var renderOnDemand: ((TimeInterval) async -> Bool)?
    /// §8.5 — renders and returns a footnote body's audio and timeline.
    public var prepareFootnote: ((UUID) async -> (url: URL, words: [WordTiming])?)?

    public var duration: TimeInterval { timeline.duration }

    public init(timeline: Timeline = Timeline(words: [])) {
        self.timeline = timeline
        session.onEvent = { [weak self] event in
            guard let self else { return }
            switch event {
            case .interrupted:
                self.wasPlayingBeforeInterruption = self.isPlaying
                self.pause()
            case .interruptionEndedShouldResume:
                if self.wasPlayingBeforeInterruption { self.play() }
            case .interruptionEnded:
                break
            case .routeDisconnected:
                self.pause()
            }
        }
    }

    // MARK: Loading

    public func load(
        timeline: Timeline,
        audioURL: URL,
        title: String,
        artwork: UIImage?,
        renderedThrough: TimeInterval
    ) throws {
        self.timeline = timeline
        self.renderedThrough = renderedThrough
        try engine.open(url: audioURL)
        engine.rate = rate
        position = 0
        wordIndex = timeline.isEmpty ? nil : 0

        nowPlaying.setMetadata(title: title, duration: timeline.duration, artwork: artwork)
        nowPlaying.install(
            handlers: NowPlayingController.Handlers(
                play: { [weak self] in self?.play() },
                pause: { [weak self] in self?.pause() },
                skip: { [weak self] delta in self?.skip(by: delta) },
                seek: { [weak self] time in self?.seek(to: time) }
            )
        )
    }

    /// Called as Phase B advances.
    public func updateRenderedEdge(_ edge: TimeInterval) {
        let previous = renderedThrough
        renderedThrough = edge
        guard edge > previous else { return }
        engine.refreshLength()
        if isPlaying {
            engine.extend(to: edge, from: max(scheduledThrough, position))
            scheduledThrough = edge
        }
    }

    // MARK: §8.4 Transport

    public func play() {
        guard footnote == nil else { return }
        do {
            try session.activate()
            // §7.3 — play to the edge and stop there.
            if position >= renderedThrough, renderedThrough < duration {
                Task { await self.renderThenPlay(at: position) }
                return
            }
            try engine.play(from: position, through: renderedThrough)
            scheduledThrough = renderedThrough
            isPlaying = true
            startDisplayLink()
            nowPlaying.update(elapsed: position, rate: rate, isPlaying: true)
        } catch {
            isPlaying = false
        }
    }

    public func pause() {
        engine.pause()
        isPlaying = false
        stopDisplayLink()
        nowPlaying.update(elapsed: position, rate: rate, isPlaying: false)
    }

    public func toggle() {
        isPlaying ? pause() : play()
    }

    /// §8.4 — "Skip ±15 s, snapped to the nearest `WordTiming` boundary — never a
    /// raw audio seek, or you land mid-word."
    public func skip(by delta: TimeInterval) {
        seek(to: timeline.skip(from: position, by: delta))
    }

    /// §8.4 — "Previous / next paragraph, using `Block` boundaries."
    public func previousBlock() {
        seek(to: timeline.previousBlockStart(from: position))
    }

    public func nextBlock() {
        seek(to: timeline.nextBlockStart(from: position))
    }

    public func seek(to time: TimeInterval) {
        let target = timeline.snapped(max(0, min(duration, time)))
        position = target
        wordIndex = timeline.index(at: target)
        nowPlaying.update(elapsed: target, rate: rate, isPlaying: isPlaying)

        guard isPlaying else { return }
        if target >= renderedThrough, renderedThrough < duration {
            engine.pause()
            Task { await self.renderThenPlay(at: target) }
            return
        }
        try? engine.play(from: target, through: renderedThrough)
        scheduledThrough = renderedThrough
    }

    private func renderThenPlay(at time: TimeInterval) async {
        let rendered = await (renderOnDemand?(time)) ?? false
        guard rendered else {
            isPlaying = false
            return
        }
        engine.refreshLength()
        renderedThrough = max(renderedThrough, time)
        do {
            try engine.play(from: time, through: max(renderedThrough, time + 1))
            scheduledThrough = renderedThrough
            isPlaying = true
            startDisplayLink()
        } catch {
            isPlaying = false
        }
    }

    // MARK: §8.3 Highlight sync

    /// "Drive updates from a `CADisplayLink` at screen refresh, not an audio
    /// render callback (no UI work on the render thread)."
    private func startDisplayLink() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() {
        guard let time = engine.currentTime() else { return }

        if footnote != nil {
            footnote?.wordIndex = footnoteTimeline?.index(at: time)
            if time >= (footnoteTimeline?.duration ?? 0) { endFootnote() }
            return
        }

        position = min(time, duration)
        wordIndex = timeline.index(at: position)
        nowPlaying.update(elapsed: position, rate: rate, isPlaying: isPlaying)

        // §7.3 — "Play to the edge and stop there."
        if position >= renderedThrough - 0.05, renderedThrough < duration, !engine.isPlaying {
            pause()
        }
        if position >= duration - 0.05 {
            pause()
            position = duration
        }
    }

    // MARK: §8.5 Footnote interjection

    private var footnoteTimeline: Timeline?
    private let footnoteEngine = AudioEngine()

    /// "Tapping a `.footnoteMarker` in the reflow view: pause main stream →
    /// render that footnote body's chunks on demand → play → resume at the same
    /// word. The main timeline position must not move."
    public func interject(footnoteBodyID: UUID) {
        guard footnote == nil else { return }
        let resumeAt = position
        let wasPlaying = isPlaying
        pause()

        Task { @MainActor in
            guard
                let prepare = self.prepareFootnote,
                let prepared = await prepare(footnoteBodyID)
            else {
                if wasPlaying { self.play() }
                return
            }
            let noteTimeline = Timeline(words: prepared.words)
            self.footnoteTimeline = noteTimeline
            self.footnote = FootnoteState(blockID: footnoteBodyID, resumeAt: resumeAt, wordIndex: 0)
            do {
                try self.footnoteEngine.open(url: prepared.url)
                self.footnoteEngine.rate = self.rate
                try self.footnoteEngine.play(from: 0, through: noteTimeline.duration)
                self.isPlaying = true
                self.startDisplayLink()
            } catch {
                self.endFootnote()
            }
        }
    }

    public func endFootnote() {
        guard let state = footnote else { return }
        footnoteEngine.stop()
        footnoteTimeline = nil
        footnote = nil
        // The main position never moved, so resuming is just playing again.
        position = state.resumeAt
        wordIndex = timeline.index(at: position)
        play()
    }

    /// Reads back the current time from the footnote engine for the UI.
    public func footnotePosition() -> TimeInterval {
        footnoteEngine.currentTime() ?? 0
    }

    public func unload() {
        pause()
        stopDisplayLink()
        engine.stop()
        footnoteEngine.stop()
        nowPlaying.clear()
        session.deactivate()
    }
}
