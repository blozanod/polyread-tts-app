import Foundation

/// §8.3 — the lookup structure behind both highlight surfaces.
///
/// "Binary-search `[WordTiming]`, but cache the last index and search outward
/// from it — playback is monotonic except on seek."
///
/// Not an actor: it is read from the `CADisplayLink` callback on the main thread
/// at screen refresh and must not await anything. Confined to the main actor
/// instead, which is where the UI that owns it lives.
@MainActor
public final class Timeline {

    public let words: [WordTiming]

    /// §8.4 — paragraph transport. Index of the first word of each block, in
    /// document order, plus the block id so the UI can name the current block.
    public let blockStarts: [(blockID: UUID, wordIndex: Int)]

    private var cursor: Int = 0

    public init(words: [WordTiming]) {
        self.words = words
        var starts: [(UUID, Int)] = []
        var lastBlock: UUID?
        for (i, w) in words.enumerated() where w.blockID != lastBlock {
            starts.append((w.blockID, i))
            lastBlock = w.blockID
        }
        self.blockStarts = starts
    }

    public var isEmpty: Bool { words.isEmpty }

    /// Exact total duration — §7.2's headline Phase A deliverable.
    public var duration: TimeInterval { words.last?.end ?? 0 }

    /// Current word index for a source-timeline position.
    ///
    /// Returns nil only for an empty timeline; a position inside an inter-chunk
    /// silence resolves to the word that silence follows, so the highlight rests
    /// on the last spoken word through a paragraph pause rather than blinking off.
    public func index(at time: TimeInterval) -> Int? {
        guard !words.isEmpty else { return nil }
        if time <= words[0].start { cursor = 0; return 0 }
        if time >= words[words.count - 1].start { cursor = words.count - 1; return cursor }

        // Monotonic fast path: playback almost always advances by 0 or 1 words
        // between display refreshes.
        if contains(index: cursor, time) { return cursor }
        if cursor + 1 < words.count, contains(index: cursor + 1, time) {
            cursor += 1
            return cursor
        }

        // Galloping outward from the cursor, then a bounded binary search. On a
        // scrub this degrades to a plain binary search over the whole array.
        var lo = 0
        var hi = words.count - 1
        if time > words[cursor].start {
            lo = cursor
            var step = 1
            while lo + step < words.count, words[lo + step].start <= time {
                lo += step
                step <<= 1
            }
            hi = min(words.count - 1, lo + step)
        } else {
            hi = cursor
            var step = 1
            while hi - step >= 0, words[hi - step].start > time {
                hi -= step
                step <<= 1
            }
            lo = max(0, hi - step)
        }

        // Last index whose start <= time.
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if words[mid].start <= time { lo = mid } else { hi = mid - 1 }
        }
        cursor = lo
        return lo
    }

    private func contains(index: Int, _ time: TimeInterval) -> Bool {
        guard index >= 0, index < words.count else { return false }
        let start = words[index].start
        let nextStart = index + 1 < words.count ? words[index + 1].start : .infinity
        return time >= start && time < nextStart
    }

    /// §8.4 — "Skip ±15 s, snapped to the nearest `WordTiming` boundary — never a
    /// raw audio seek, or you land mid-word."
    public func snapped(_ time: TimeInterval) -> TimeInterval {
        guard let i = index(at: time) else { return 0 }
        return words[i].start
    }

    public func skip(from time: TimeInterval, by delta: TimeInterval) -> TimeInterval {
        snapped(max(0, min(duration, time + delta)))
    }

    public func startOfWord(_ index: Int) -> TimeInterval {
        guard index >= 0, index < words.count else { return 0 }
        return words[index].start
    }

    /// §8.4 — previous / next paragraph, using `Block` boundaries.
    ///
    /// "Previous" within the first 1.5 s of a block goes to the block before it,
    /// and past that restarts the current one — the behaviour every audio player
    /// has trained people to expect from a back button.
    public func previousBlockStart(from time: TimeInterval) -> TimeInterval {
        guard let current = currentBlockStartIndex(at: time) else { return 0 }
        let currentStart = words[blockStarts[current].wordIndex].start
        if time - currentStart > 1.5 || current == 0 { return currentStart }
        return words[blockStarts[current - 1].wordIndex].start
    }

    public func nextBlockStart(from time: TimeInterval) -> TimeInterval {
        guard let current = currentBlockStartIndex(at: time) else { return duration }
        guard current + 1 < blockStarts.count else { return duration }
        return words[blockStarts[current + 1].wordIndex].start
    }

    public func blockID(at time: TimeInterval) -> UUID? {
        guard let i = index(at: time) else { return nil }
        return words[i].blockID
    }

    private func currentBlockStartIndex(at time: TimeInterval) -> Int? {
        guard let wordIndex = index(at: time), !blockStarts.isEmpty else { return nil }
        var lo = 0
        var hi = blockStarts.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if blockStarts[mid].wordIndex <= wordIndex { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }
}
