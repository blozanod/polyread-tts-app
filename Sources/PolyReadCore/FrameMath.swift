import Foundation

/// §3 — "one frame is 600 samples at 24 kHz, so 40 frames/sec, 0.025 s/frame."
///
/// `duration` comes out of KokoroProsody unrounded. Round to at least 1 *before*
/// the gather and use the rounded values for timing, so the audio the acoustic
/// model emits and the timeline the scrubber reads agree exactly. Every rounding
/// in the codebase goes through `roundedFrames` so there is one rule, not five.
public enum FrameMath {
    public static let sampleRate: Double = 24_000
    public static let samplesPerFrame: Int = 600
    public static let framesPerSecond: Double = sampleRate / Double(samplesPerFrame)  // 40
    public static let secondsPerFrame: Double = Double(samplesPerFrame) / sampleRate  // 0.025

    /// The single rounding rule. `max(1, ...)` because a zero-frame token would
    /// collapse a word to zero width on the timeline and the highlight would skip it.
    public static func roundedFrames(_ raw: Float) -> Int {
        max(1, Int(raw.rounded()))
    }

    public static func roundedFrames(_ raw: [Float]) -> [Int] {
        raw.map(roundedFrames)
    }

    public static func seconds(frames: Int) -> TimeInterval {
        Double(frames) * secondsPerFrame
    }

    public static func frames(seconds: TimeInterval) -> Int {
        Int((seconds * framesPerSecond).rounded())
    }

    public static func samples(frames: Int) -> Int {
        frames * samplesPerFrame
    }

    public static func seconds(samples: Int) -> TimeInterval {
        Double(samples) / sampleRate
    }

    public static func samples(seconds: TimeInterval) -> Int {
        Int((seconds * sampleRate).rounded())
    }
}

/// §5 / §4.6 — inter-chunk silence. Kokoro ignores inline markup, so paragraph
/// pauses are real silence inserted between rendered chunks.
public enum Pause {
    public static let paragraph: TimeInterval = 0.400   // §5: 300–500 ms
    public static let heading: TimeInterval = 0.400     // §4.6: 400 ms before and after
    public static let withinBlock: TimeInterval = 0     // a split block is one utterance

    public static func frames(_ interval: TimeInterval) -> Int {
        FrameMath.frames(seconds: interval)
    }
}
