import Foundation
import CoreGraphics
import PDFKit
import UIKit
import PolyReadCore

/// §4.2 — "Not a presence check. Course-reserve scans frequently ship a *bad*
/// embedded OCR layer, so `page.string` returns something and it's garbage."
public struct ExtractionQuality: Sendable, Equatable {
    /// Characters per square point of page. A normal text page sits near 0.006;
    /// a scan whose embedded layer caught a few stray glyphs sits near zero.
    public let density: Double
    /// Share of extracted word tokens that `UITextChecker` recognises.
    public let dictionaryHitRatio: Double
    public let tokenCount: Int

    /// Density saturates — twice as dense as a normal page is not twice as good —
    /// so it is clipped before being weighted. The dictionary ratio is the signal
    /// that actually separates a real text layer from a corrupt one, hence 0.7.
    public var score: Double {
        let densityTerm = min(1.0, density / Thresholds.healthyDensity)
        return 0.3 * densityTerm + 0.7 * dictionaryHitRatio
    }

    public var isAcceptable: Bool { score >= Thresholds.acceptableScore }

    public enum Thresholds {
        /// ~3,000 characters on US Letter.
        public static let healthyDensity: Double = 0.006
        /// Below this the text is not worth synthesizing. Calibrated so that a
        /// clean page (ratio ≈ 0.95) passes comfortably and a mojibake OCR layer
        /// (ratio ≈ 0.3) fails clearly.
        public static let acceptableScore: Double = 0.55
        /// Fewer tokens than this and the ratio is noise, so density alone decides.
        public static let minimumTokensForRatio = 40
    }

    public init(density: Double, dictionaryHitRatio: Double, tokenCount: Int) {
        self.density = density
        self.dictionaryHitRatio = dictionaryHitRatio
        self.tokenCount = tokenCount
    }
}

public enum ExtractionBackendChoice: String, Sendable {
    case embedded
    case vision
    /// §4.2 — "If Vision also scores badly, surface it in the import flow and let
    /// the user decide whether to continue."
    case visionLowConfidence
}

public struct BackendDecision: Sendable {
    public let choice: ExtractionBackendChoice
    public let embeddedQuality: ExtractionQuality
    public let visionQuality: ExtractionQuality?

    public var needsUserConfirmation: Bool { choice == .visionLowConfidence }
}

public struct QualityScorer {
    /// `UITextChecker` is not cheap and not thread-safe; one per scorer, used on
    /// the extraction queue.
    private let checker = UITextChecker()

    public init() {}

    public func score(runs: [TextRun], pageAreas: [Int: CGFloat]) -> ExtractionQuality {
        let totalArea = pageAreas.values.reduce(0, +)
        let characters = runs.reduce(0) { $0 + $1.text.count }
        let density = totalArea > 0 ? Double(characters) / Double(totalArea) : 0

        // Only alphabetic tokens are worth spell-checking: citations, page
        // numbers and years would drag a perfectly good text layer down.
        let words = runs
            .map { $0.text.trimmingCharacters(in: .punctuationCharacters) }
            .filter { $0.count >= 3 && $0.allSatisfy(\.isLetter) }

        guard words.count >= ExtractionQuality.Thresholds.minimumTokensForRatio else {
            return ExtractionQuality(density: density, dictionaryHitRatio: 0, tokenCount: words.count)
        }

        // Sampling: a 400-page scan does not need every token checked to know
        // whether its text layer is junk.
        let sample = stride(from: 0, to: words.count, by: max(1, words.count / 600)).map { words[$0] }
        var hits = 0
        for word in sample {
            let range = NSRange(location: 0, length: word.utf16.count)
            let misspelled = checker.rangeOfMisspelledWord(
                in: word,
                range: range,
                startingAt: 0,
                wrap: false,
                language: "en_US"
            )
            if misspelled.location == NSNotFound { hits += 1 }
        }

        return ExtractionQuality(
            density: density,
            dictionaryHitRatio: Double(hits) / Double(sample.count),
            tokenCount: words.count
        )
    }
}

/// §4.2 — decides the backend by scoring both, not by asking whether text exists.
public struct BackendSelector {
    let scorer = QualityScorer()
    /// Scoring every page of a 400-page book to pick a backend is wasted work.
    let sampleLimit: Int

    public init(sampleLimit: Int = 8) {
        self.sampleLimit = sampleLimit
    }

    public func decide(document: PDFDocument) -> BackendDecision {
        let indices = sampleIndices(pageCount: document.pageCount)
        var areas: [Int: CGFloat] = [:]
        for i in indices {
            guard let page = document.page(at: i) else { continue }
            let box = page.bounds(for: .cropBox)
            areas[i] = box.width * box.height
        }

        let embeddedRuns = indices.flatMap { (try? PDFKitBackend().runs(forPageAt: $0, in: document)) ?? [] }
        let embedded = scorer.score(runs: embeddedRuns, pageAreas: areas)
        if embedded.isAcceptable {
            return BackendDecision(choice: .embedded, embeddedQuality: embedded, visionQuality: nil)
        }

        let vision = VisionBackend()
        let visionRuns = indices.flatMap { (try? vision.runs(forPageAt: $0, in: document)) ?? [] }
        let visionQuality = scorer.score(runs: visionRuns, pageAreas: areas)

        // Re-OCR only if it is actually an improvement. A sparse-but-clean page
        // (a title page, a table) can fail the density term with a perfectly
        // usable text layer, and Vision will not beat it.
        if visionQuality.score < embedded.score {
            return BackendDecision(
                choice: embedded.isAcceptable ? .embedded : .visionLowConfidence,
                embeddedQuality: embedded,
                visionQuality: visionQuality
            )
        }

        return BackendDecision(
            choice: visionQuality.isAcceptable ? .vision : .visionLowConfidence,
            embeddedQuality: embedded,
            visionQuality: visionQuality
        )
    }

    /// Spread the sample across the document — the first pages of a scanned book
    /// are a cover and a title page and are not representative of anything.
    func sampleIndices(pageCount: Int) -> [Int] {
        guard pageCount > 0 else { return [] }
        guard pageCount > sampleLimit else { return Array(0..<pageCount) }
        let step = Double(pageCount) / Double(sampleLimit)
        return (0..<sampleLimit).map { Int((Double($0) + 0.5) * step) }
    }
}
