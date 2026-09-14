import Foundation
import CoreGraphics
import PolyReadCore

import PDFKit
import Vision
import UIKit

/// §4.1 — "Both backends emit `[TextRun]`. Everything downstream is
/// source-agnostic."
public protocol TextRunBackend: Sendable {
    var name: String { get }
    func runs(forPageAt index: Int, in document: PDFDocument) throws -> [TextRun]
}

// MARK: - Born-digital

/// §4.1 — "`PDFPage.attributedString` for text and font attributes,
/// `PDFPage.characterBounds(at:)` for geometry. Cache bounds once at import —
/// per-character calls are slow and you need them exactly once."
public struct PDFKitBackend: TextRunBackend {
    public let name = "PDFKit"

    public init() {}

    public func runs(forPageAt index: Int, in document: PDFDocument) throws -> [TextRun] {
        guard let page = document.page(at: index) else { return [] }
        let text = page.string ?? ""
        guard !text.isEmpty else { return [] }

        // The one pass over characterBounds. Everything after this is arithmetic
        // on the cached array.
        let characters = Array(text)
        var bounds = [CGRect](repeating: .null, count: characters.count)
        for i in 0..<characters.count {
            bounds[i] = page.characterBounds(at: i)
        }

        // Font sizes, read once per attribute run rather than per character.
        var pointSizes = [CGFloat](repeating: 0, count: characters.count)
        if let attributed = page.attributedString, attributed.length == characters.count {
            attributed.enumerateAttribute(
                .font,
                in: NSRange(location: 0, length: attributed.length),
                options: []
            ) { value, range, _ in
                guard let font = value as? UIFont else { return }
                let size = font.pointSize
                for i in range.location..<(range.location + range.length) where i < pointSizes.count {
                    pointSizes[i] = size
                }
            }
        }

        var runs: [TextRun] = []
        var buffer = ""
        var bufferBounds: [CGRect] = []
        var bufferSizes: [CGFloat] = []

        func flush() {
            defer {
                buffer.removeAll(keepingCapacity: true)
                bufferBounds.removeAll(keepingCapacity: true)
                bufferSizes.removeAll(keepingCapacity: true)
            }
            let token = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty else { return }
            let boxes = bufferBounds.filter { !$0.isNull && !$0.isEmpty }
            guard let union = boxes.dropFirst().reduce(boxes.first, { $0?.union($1) }) else { return }

            // Font point size is a better glyph height than the ink box when it is
            // available — an all-lowercase word has no ascender to measure. Vision
            // has no font metadata at all, which is exactly why §4.4 and §4.5
            // classify on geometry.
            let declared = bufferSizes.filter { $0 > 0 }
            let glyphHeight = declared.isEmpty ? union.height : median(declared)

            runs.append(
                TextRun(
                    text: token,
                    bbox: union,
                    glyphHeight: glyphHeight,
                    baseline: boxes.map(\.minY).min() ?? union.minY,
                    pageIndex: index
                )
            )
        }

        for (i, character) in characters.enumerated() {
            if character.isWhitespace || character.isNewline {
                flush()
            } else {
                buffer.append(character)
                bufferBounds.append(bounds[i])
                bufferSizes.append(pointSizes[i])
            }
        }
        flush()
        return runs
    }
}

// MARK: - Scanned

/// §4.1 — "`VNRecognizeTextRequest` with `.accurate`,
/// `recognitionLanguages = ["en-US"]`. Use `VNRecognizedText.boundingBox(for:)`
/// for sub-observation geometry. Vision returns no font metadata, so
/// `glyphHeight` comes from the bbox."
public struct VisionBackend: TextRunBackend {
    public let name = "Vision"

    /// 300 dpi is the floor where `.accurate` stops losing 8-point footnote text
    /// on a course-reserve scan. Above ~400 the runtime grows without the
    /// recognition improving.
    public let renderDPI: CGFloat

    public init(renderDPI: CGFloat = 300) {
        self.renderDPI = renderDPI
    }

    public func runs(forPageAt index: Int, in document: PDFDocument) throws -> [TextRun] {
        guard let page = document.page(at: index) else { return [] }
        let geometry = PageGeometry(page: page)
        guard let image = render(page: page, geometry: geometry) else { return [] }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        var runs: [TextRun] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let line = candidate.string

            // Sub-observation geometry, one box per whitespace-delimited token.
            for tokenRange in tokenRanges(in: line) {
                let token = String(line[tokenRange])
                guard !token.isEmpty else { continue }
                let box: CGRect
                if let sub = try? candidate.boundingBox(for: tokenRange) {
                    box = geometry.pageRect(fromNormalized: sub.boundingBox)
                } else {
                    box = geometry.pageRect(fromNormalized: observation.boundingBox)
                }
                runs.append(
                    TextRun(
                        text: token,
                        bbox: box,
                        glyphHeight: box.height,
                        baseline: box.minY,
                        pageIndex: index
                    )
                )
            }
        }
        return runs
    }

    private func tokenRanges(in line: String) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var start: String.Index?
        var i = line.startIndex
        while i < line.endIndex {
            if line[i].isWhitespace {
                if let s = start { ranges.append(s..<i); start = nil }
            } else if start == nil {
                start = i
            }
            i = line.index(after: i)
        }
        if let s = start { ranges.append(s..<line.endIndex) }
        return ranges
    }

    private func render(page: PDFPage, geometry: PageGeometry) -> CGImage? {
        let scale = renderDPI / 72.0
        let size = geometry.displaySize
        let width = Int((size.width * scale).rounded())
        let height = Int((size.height * scale).rounded())
        guard width > 0, height > 0 else { return nil }

        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }

        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)
        // `draw(with:to:)` applies /Rotate itself, so the context only needs to be
        // the right size — PageGeometry handles mapping the result back.
        page.draw(with: .cropBox, to: context)
        return context.makeImage()
    }
}

func median(_ values: [CGFloat]) -> CGFloat {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let mid = sorted.count / 2
    return sorted.count.isMultiple(of: 2)
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
}
