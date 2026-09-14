import Foundation
import AVFoundation
import PolyReadCore

/// §8.1 — "`AVAudioPlayerNode` → `AVAudioUnitTimePitch` → `mainMixerNode`.
/// Source format 24 kHz mono; let the engine convert to the output format."
public final class AudioEngine {

    public let engine = AVAudioEngine()
    public let player = AVAudioPlayerNode()
    public let timePitch = AVAudioUnitTimePitch()

    /// Where in the *source* timeline the currently scheduled segment begins.
    /// §8.3 reads position relative to this, which is why no rate rescaling is
    /// needed anywhere in this file.
    private(set) var segmentStartTime: TimeInterval = 0
    private var file: AVAudioFile?
    private var isRunning = false

    public init() {
        engine.attach(player)
        engine.attach(timePitch)
        engine.connect(player, to: timePitch, format: nil)
        engine.connect(timePitch, to: engine.mainMixerNode, format: nil)
    }

    public var sourceFormat: AVAudioFormat? { file?.processingFormat }

    public func open(url: URL) throws {
        file = try AVAudioFile(forReading: url)
    }

    /// §8.2 — "`AVAudioUnitTimePitch.rate`. **Do not** follow the card's advice
    /// to divide durations by speed at synthesis — under two-phase rendering
    /// that invalidates every cached chunk on every speed change."
    public var rate: Float {
        get { timePitch.rate }
        set { timePitch.rate = max(0.5, min(3.0, newValue)) }
    }

    public var isPlaying: Bool { player.isPlaying }

    /// Schedules from `time` to the rendered edge and starts. §7.3: "Play to the
    /// edge and stop there."
    public func play(from time: TimeInterval, through edge: TimeInterval) throws {
        guard let file else { throw PolyReadError.audioFormatUnavailable }
        let sampleRate = file.processingFormat.sampleRate
        let startFrame = AVAudioFramePosition(max(0, time) * sampleRate)
        let edgeFrame = AVAudioFramePosition(max(0, edge) * sampleRate)
        let available = min(edgeFrame, file.length) - startFrame
        guard available > 0 else { return }

        if !isRunning {
            engine.prepare()
            try engine.start()
            isRunning = true
        }

        player.stop()
        segmentStartTime = time
        player.scheduleSegment(
            file,
            startingFrame: startFrame,
            frameCount: AVAudioFrameCount(available),
            at: nil
        )
        player.play()
    }

    /// Extends the scheduled region without interrupting playback — Phase B
    /// moving the edge forward should not click.
    public func extend(to edge: TimeInterval, from scheduledThrough: TimeInterval) {
        guard let file, player.isPlaying else { return }
        let sampleRate = file.processingFormat.sampleRate
        let startFrame = AVAudioFramePosition(scheduledThrough * sampleRate)
        let edgeFrame = min(AVAudioFramePosition(edge * sampleRate), file.length)
        let available = edgeFrame - startFrame
        guard available > 0 else { return }
        player.scheduleSegment(
            file,
            startingFrame: startFrame,
            frameCount: AVAudioFrameCount(available),
            at: nil
        )
    }

    public func pause() {
        player.pause()
    }

    public func resume() throws {
        if !isRunning {
            engine.prepare()
            try engine.start()
            isRunning = true
        }
        player.play()
    }

    public func stop() {
        player.stop()
        engine.stop()
        isRunning = false
    }

    /// §8.3 — "Read position from `AVAudioPlayerNode.playerTime` (converted via
    /// `nodeTime`), **not** wall clock. That is the *source* timeline,
    /// pre-time-stretch, so `[WordTiming]` indexes directly and needs **no** rate
    /// rescaling."
    public func currentTime() -> TimeInterval? {
        guard
            let nodeTime = player.lastRenderTime,
            let playerTime = player.playerTime(forNodeTime: nodeTime)
        else { return nil }
        return segmentStartTime + Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    /// The file grows while Phase B runs, and `AVAudioFile` caches its length at
    /// open. Reopening picks up the new frames.
    public func refreshLength() {
        guard let url = file?.url else { return }
        file = try? AVAudioFile(forReading: url)
    }
}
