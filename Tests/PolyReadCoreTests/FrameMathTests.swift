import Testing
import Foundation
@testable import PolyReadCore

@Suite("§3 frame arithmetic")
struct FrameMathTests {

    @Test("600 samples at 24 kHz is 40 frames per second")
    func constants() {
        #expect(FrameMath.framesPerSecond == 40)
        #expect(FrameMath.secondsPerFrame == 0.025)
        #expect(FrameMath.samples(frames: 40) == 24_000)
    }

    /// §3 — "round to at least 1 before the gather".
    @Test("durations round to at least one frame")
    func roundingFloor() {
        #expect(FrameMath.roundedFrames(0.0) == 1)
        #expect(FrameMath.roundedFrames(0.4) == 1)
        #expect(FrameMath.roundedFrames(-3.0) == 1)
        #expect(FrameMath.roundedFrames(1.5) == 2)
        #expect(FrameMath.roundedFrames(2.49) == 2)
    }

    /// The reason §3 insists on rounding *before* the gather: the sum of the
    /// rounded values is the audio length, and anything else desynchronises the
    /// timeline from the audio.
    @Test("rounded totals are what the timeline must use")
    func roundedTotalsMatchAudio() {
        let raw: [Float] = [1.4, 1.4, 1.4, 1.4, 1.4]
        let rounded = FrameMath.roundedFrames(raw)
        #expect(rounded.reduce(0, +) == 5)
        #expect(raw.reduce(0, +) == 7.0)
        // Using the unrounded sum would put the timeline 50 ms ahead of the
        // audio after five phonemes, and metres ahead over a paragraph.
        #expect(FrameMath.seconds(frames: rounded.reduce(0, +)) == 0.125)
    }

    @Test("pauses convert to whole frames")
    func pauses() {
        #expect(Pause.frames(Pause.paragraph) == 16)   // 400 ms at 40 fps
        #expect(Pause.frames(Pause.withinBlock) == 0)
    }
}
