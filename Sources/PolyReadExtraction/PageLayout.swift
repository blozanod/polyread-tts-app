import Foundation
import CoreGraphics
import PolyReadCore

/// A run of text on one baseline, in one column. Lines are the working unit for
/// §4.4 and §4.5 — a classifier that looks at single words gets confused by the
/// first word of a footnote, and one that looks at whole paragraphs cannot see a
/// running head at all.
struct Line {
    var runs: [TextRun]
    var columnIndex: Int
    var pageIndex: Int

    var bbox: CGRect {
        runs.dropFirst().reduce(runs[0].bbox) { $0.union($1.bbox) }
    }
    var baseline: CGFloat { median(runs.map(\.baseline)) }
    var glyphHeight: CGFloat { median(runs.map(\.glyphHeight)) }
    var text: String { runs.map(\.text).joined(separator: " ") }
}

// MARK: - §4.3 Column detection

/// "Per page, histogram run bbox x-midpoints in ~10 pt bins. Look for a
/// zero-density gap spanning >15% of page width, centred between 30% and 70% of
/// page width."
public enum ColumnDetector {
    static let binWidth: CGFloat = 10
    static let minimumGapFraction: CGFloat = 0.15
    static let gapCentreRange: ClosedRange<CGFloat> = 0.30...0.70

    /// Returns the x of the column split, or nil for a single column.
    static func splitX(runs: [TextRun], pageBox: CGRect) -> CGFloat? {
        guard runs.count >= 12, pageBox.width > 0 else { return nil }

        let binCount = max(1, Int((pageBox.width / binWidth).rounded(.up)))
        var histogram = [Int](repeating: 0, count: binCount)
        for run in runs {
            let offset = run.bbox.midX - pageBox.minX
            let bin = Int(offset / binWidth)
            guard bin >= 0, bin < binCount else { continue }
            histogram[bin] += 1
        }

        // Longest zero-density stretch that is not the outer margin.
        var best: (start: Int, length: Int)?
        var runStart: Int?
        for i in 0..<binCount {
            if histogram[i] == 0 {
                if runStart == nil { runStart = i }
            } else if let s = runStart {
                consider(start: s, end: i, into: &best)
                runStart = nil
            }
        }
        if let s = runStart { consider(start: s, end: binCount, into: &best) }

        guard let gap = best else { return nil }
        let gapWidth = CGFloat(gap.length) * binWidth
        guard gapWidth > pageBox.width * minimumGapFraction else { return nil }

        let centre = (CGFloat(gap.start) + CGFloat(gap.length) / 2) * binWidth
        let centreFraction = centre / pageBox.width
        guard gapCentreRange.contains(centreFraction) else { return nil }

        return pageBox.minX + centre
    }

    private static func consider(start: Int, end: Int, into best: inout (start: Int, length: Int)?) {
        let length = end - start
        if best == nil || length > best!.length {
            best = (start, length)
        }
    }

    /// Assigns `columnIndex` and sorts into reading order: column-major for two
    /// columns, plain descending-y for one.
    public static func order(runs: [TextRun], pageBox: CGRect) -> [TextRun] {
        var runs = runs
        let split = splitX(runs: runs, pageBox: pageBox)

        for i in runs.indices {
            runs[i].columnIndex = (split.map { runs[i].bbox.midX >= $0 } ?? false) ? 1 : 0
        }

        // Group into lines before sorting: sorting individual runs by y alone
        // shuffles words whose baselines differ by a fraction of a point.
        let lines = groupIntoLines(runs: runs)
        let sorted = lines.sorted { a, b in
            if a.columnIndex != b.columnIndex { return a.columnIndex < b.columnIndex }
            if abs(a.baseline - b.baseline) > max(a.glyphHeight, b.glyphHeight) * 0.5 {
                return a.baseline > b.baseline   // origin bottom-left: higher y is earlier
            }
            return a.bbox.minX < b.bbox.minX
        }
        return sorted.flatMap { line in
            line.runs.sorted { $0.bbox.minX < $1.bbox.minX }
        }
    }

    /// Runs whose baselines agree within half a glyph height are one line.
    static func groupIntoLines(runs: [TextRun]) -> [Line] {
        guard !runs.isEmpty else { return [] }
        var byColumn: [Int: [TextRun]] = [:]
        for run in runs { byColumn[run.columnIndex, default: []].append(run) }

        var lines: [Line] = []
        for (column, columnRuns) in byColumn {
            let sorted = columnRuns.sorted { $0.baseline > $1.baseline }
            var current: [TextRun] = []
            var currentBaseline: CGFloat = 0
            for run in sorted {
                let tolerance = max(2, run.glyphHeight * 0.5)
                if current.isEmpty || abs(run.baseline - currentBaseline) <= tolerance {
                    if current.isEmpty { currentBaseline = run.baseline }
                    current.append(run)
                } else {
                    lines.append(Line(runs: current, columnIndex: column, pageIndex: current[0].pageIndex))
                    current = [run]
                    currentBaseline = run.baseline
                }
            }
            if !current.isEmpty {
                lines.append(Line(runs: current, columnIndex: column, pageIndex: current[0].pageIndex))
            }
        }
        return lines
    }
}

// MARK: - §4.4 Running heads and page numbers

/// "Position alone is insufficient — footnote bodies also live in the bottom
/// region." So: band **and** (bare number **or** a digit-normalized form that
/// repeats across the document).
public struct FurnitureClassifier {
    static let bandFraction: CGFloat = 0.08
    static let repeatThreshold: Double = 0.40

    /// Digit-normalized forms seen per page, built in a first pass over the
    /// document because the repeat test is inherently cross-page.
    private var formPageCounts: [String: Set<Int>] = [:]
    private var pageCount: Int = 0

    public init() {}

    public static func normalizedForm(_ text: String) -> String {
        var out = ""
        var inDigits = false
        for character in text.lowercased() {
            if character.isNumber {
                if !inDigits { out.append("#"); inDigits = true }
            } else {
                inDigits = false
                if character.isLetter || character == " " { out.append(character) }
            }
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    public static func isBareNumber(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: CharacterSet(charactersIn: " .[]()-–—"))
        guard !trimmed.isEmpty else { return false }
        if trimmed.allSatisfy(\.isNumber) { return true }
        // Front matter is numbered in lowercase roman.
        return trimmed.count <= 7 && trimmed.allSatisfy { "ivxlcdm".contains($0) }
    }

    /// First pass: which candidate line forms appear in the band, and on how many pages.
    public mutating func observe(lines: [Line], pageBox: CGRect, pageIndex: Int) {
        pageCount = max(pageCount, pageIndex + 1)
        for line in lines where inBand(line.bbox, pageBox: pageBox) {
            formPageCounts[Self.normalizedForm(line.text), default: []].insert(pageIndex)
        }
    }

    /// Second pass: classify.
    public func role(for line: Line, pageBox: CGRect) -> BlockRole? {
        guard inBand(line.bbox, pageBox: pageBox) else { return nil }
        let text = line.text.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }

        if Self.isBareNumber(text) { return .pageNumber }

        let form = Self.normalizedForm(text)
        guard !form.isEmpty, pageCount > 0 else { return nil }
        let pagesSeen = formPageCounts[form]?.count ?? 0
        guard Double(pagesSeen) / Double(pageCount) >= Self.repeatThreshold else { return nil }

        // A repeating form that is mostly digits is a folio; anything else is a
        // running head.
        return form.contains(where: \.isLetter) ? .runningHead : .pageNumber
    }

    private func inBand(_ box: CGRect, pageBox: CGRect) -> Bool {
        let band = pageBox.height * Self.bandFraction
        return box.maxY >= pageBox.maxY - band || box.minY <= pageBox.minY + band
    }
}

// MARK: - §4.5 Footnotes

public enum FootnoteClassifier {
    static let markerHeightRatio: CGFloat = 0.8
    static let markerBaselineLift: CGFloat = 0.15
    static let bodyHeightRatio: CGFloat = 0.85
    static let markerSymbols: Set<Character> = ["†", "‡", "*", "§", "¶", "‖"]

    /// "**Markers**: `glyphHeight < 0.8 ×` line median, **and** baseline offset
    /// `> 0.15 ×` line height above the line baseline, **and** text is digits or
    /// `† ‡ * §`."
    static func isMarker(run: TextRun, line: Line) -> Bool {
        let lineHeight = line.glyphHeight
        guard lineHeight > 0 else { return false }
        guard run.glyphHeight < lineHeight * markerHeightRatio else { return false }
        guard run.baseline - line.baseline > lineHeight * markerBaselineLift else { return false }
        return isMarkerText(run.text)
    }

    static func isMarkerText(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:)]"))
        guard !trimmed.isEmpty, trimmed.count <= 4 else { return false }
        if trimmed.allSatisfy(\.isNumber) { return true }
        return trimmed.allSatisfy { markerSymbols.contains($0) }
    }

    /// "**Bodies**: contiguous runs in the bottom region whose median
    /// `glyphHeight < 0.85 ×` the page's body median, grouped upward from the
    /// page bottom until glyph height returns to body size."
    ///
    /// Returns the indices of `lines` (assumed in reading order within a column)
    /// that belong to the footnote apparatus.
    static func bodyLineIndices(
        lines: [Line],
        bodyGlyphHeight: CGFloat,
        pageBox: CGRect
    ) -> Set<Int> {
        guard bodyGlyphHeight > 0 else { return [] }
        let ceiling = bodyGlyphHeight * bodyHeightRatio
        // The apparatus never climbs above the lower third; without this a page
        // set entirely in small type reads as one giant footnote.
        let highestAllowedY = pageBox.minY + pageBox.height * 0.40

        var result = Set<Int>()
        // Grouping upward from the page bottom means walking the reading order
        // backwards, per column.
        var byColumn: [Int: [Int]] = [:]
        for (i, line) in lines.enumerated() { byColumn[line.columnIndex, default: []].append(i) }

        for (_, indices) in byColumn {
            let ordered = indices.sorted { lines[$0].baseline < lines[$1].baseline }  // bottom-up
            for index in ordered {
                let line = lines[index]
                guard line.glyphHeight < ceiling else { break }
                guard line.bbox.minY <= highestAllowedY else { break }
                result.insert(index)
            }
        }
        return result
    }

    /// Footnote bodies open with their own label — the counterpart of the marker
    /// in the text. Used to pair marker to body (§8.5) and to strip the label
    /// from what gets spoken.
    static func leadingLabel(of line: Line) -> String? {
        guard let first = line.runs.first else { return nil }
        let trimmed = first.text.trimmingCharacters(in: CharacterSet(charactersIn: ".)]"))
        guard isMarkerText(trimmed) else { return nil }
        return trimmed
    }
}
