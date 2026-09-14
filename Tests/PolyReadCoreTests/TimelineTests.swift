import Testing
import Foundation
@testable import PolyReadCore

private func span(_ page: Int = 0, _ location: Int = 0) -> SourceSpan {
    SourceSpan(pageIndex: page, bboxes: [], reflowRange: NSRange(location: location, length: 4))
}

private func timeline(_ count: Int, blockEvery: Int = 4) -> Timeline {
    var blockIDs: [UUID] = []
    var words: [WordTiming] = []
    for i in 0..<count {
        if i % blockEvery == 0 { blockIDs.append(UUID()) }
        words.append(
            WordTiming(
                start: Double(i) * 0.5,
                end: Double(i) * 0.5 + 0.4,
                span: span(0, i * 5),
                blockID: blockIDs.last!
            )
        )
    }
    return Timeline(words: words)
}

@MainActor
@Suite("§8.3 timeline lookup")
struct TimelineTests {

    @Test("lookup is exact at boundaries and inside words")
    func lookup() {
        let line = timeline(20)
        #expect(line.index(at: -5) == 0)
        #expect(line.index(at: 0) == 0)
        #expect(line.index(at: 0.25) == 0)
        #expect(line.index(at: 0.5) == 1)
        #expect(line.index(at: 4.9) == 9)
        #expect(line.index(at: 9999) == 19)
    }

    /// §8.3 — "cache the last index and search outward from it — playback is
    /// monotonic except on seek." Monotonic walking and random scrubbing must
    /// agree, or the cursor optimisation is a bug generator.
    @Test("cursor-cached walk agrees with a cold lookup")
    func cursorMatchesColdLookup() {
        let line = timeline(500)
        var walked: [Int?] = []
        for step in stride(from: 0.0, to: 250.0, by: 0.1) {
            walked.append(line.index(at: step))
        }
        // Same queries, but jumping around so the cursor is never useful.
        let cold = Timeline(words: line.words)
        var scattered: [Int?] = []
        let times = Array(stride(from: 0.0, to: 250.0, by: 0.1))
        for time in times.shuffled() { _ = cold.index(at: time) }
        for time in times { scattered.append(cold.index(at: time)) }
        #expect(walked == scattered)
    }

    @Test("seeking backwards finds the right word")
    func backwardSeek() {
        let line = timeline(100)
        _ = line.index(at: 49)
        #expect(line.index(at: 1.2) == 2)
        #expect(line.index(at: 0.1) == 0)
    }

    /// §8.4 — "Skip ±15 s, snapped to the nearest `WordTiming` boundary — never a
    /// raw audio seek, or you land mid-word."
    @Test("skip lands on a word boundary")
    func skipSnaps() {
        let line = timeline(100)
        let result = line.skip(from: 3.3, by: 15)
        #expect(line.words.contains { $0.start == result })
        #expect(line.skip(from: 1, by: -60) == 0)
    }

    @Test("paragraph transport uses block boundaries")
    func paragraphTransport() {
        let line = timeline(20, blockEvery: 4)
        // Past 1.5 s into a block, "previous" restarts it.
        #expect(line.previousBlockStart(from: 4.0) == 4.0)
        // Early in a block, it goes to the one before.
        #expect(line.previousBlockStart(from: 4.2) == 2.0)
        #expect(line.nextBlockStart(from: 4.2) == 6.0)
    }

    @Test("an empty timeline does not crash the display link")
    func emptyTimeline() {
        let line = Timeline(words: [])
        #expect(line.index(at: 1) == nil)
        #expect(line.duration == 0)
        #expect(line.snapped(5) == 0)
    }
}
