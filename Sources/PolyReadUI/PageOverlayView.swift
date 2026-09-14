import SwiftUI
import UIKit
import PDFKit
import PolyReadCore

/// §10 — "**Regular width (iPad): the rendered page.** A custom overlay layer
/// over `PDFView` drawing rects from `SourceSpan.bboxes`. **Not `PDFSelection`**
/// — scanned documents have no text layer to select, and a bbox-driven overlay
/// serves both backends identically. Needs column-aware auto-scroll and page
/// advance to keep the spoken word visible."
public struct PageOverlayView: UIViewRepresentable {

    let document: PDFDocument
    let span: SourceSpan?

    public init(document: PDFDocument, span: SourceSpan?) {
        self.document = document
        self.span = span
    }

    public func makeUIView(context: Context) -> HighlightingPDFView {
        let view = HighlightingPDFView()
        view.document = document
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .secondarySystemBackground
        return view
    }

    public func updateUIView(_ view: HighlightingPDFView, context: Context) {
        if view.document !== document { view.document = document }
        view.show(span: span)
    }
}

/// `PDFView` with one overlay layer on top of the scroll content. The boxes are
/// in PDF user space and converted per page, so they follow zoom and scroll for
/// free.
public final class HighlightingPDFView: PDFView {

    private let overlay = CAShapeLayer()
    private var currentSpan: SourceSpan?

    public override init(frame: CGRect) {
        super.init(frame: frame)
        configureOverlay()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureOverlay()
    }

    private func configureOverlay() {
        overlay.fillColor = UIColor.tintColor.withAlphaComponent(0.30).cgColor
        overlay.strokeColor = UIColor.clear.cgColor
        overlay.zPosition = 10
        layer.addSublayer(overlay)

        // The boxes have to be redrawn on zoom and on every scroll tick, since
        // they live in page space and the layer lives in view space.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(redraw),
            name: .PDFViewScaleChanged,
            object: self
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(redraw),
            name: .PDFViewPageChanged,
            object: self
        )
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        overlay.frame = bounds
        redraw()
    }

    public func show(span: SourceSpan?) {
        guard span != currentSpan else { return }
        currentSpan = span
        scrollIfNeeded()
        redraw()
    }

    @objc private func redraw() {
        guard
            let span = currentSpan,
            let document,
            span.pageIndex >= 0, span.pageIndex < document.pageCount,
            let page = document.page(at: span.pageIndex)
        else {
            overlay.path = nil
            return
        }

        let path = UIBezierPath()
        for box in span.bboxes {
            // §4.6 — a hyphenated word has two boxes on two lines, and both
            // light up. Padded slightly so the highlight reads as a marker rather
            // than as a tight box clipping the descenders.
            let converted = convert(box.insetBy(dx: -1.5, dy: -1.5), from: page)
            guard converted.isFinite, !converted.isNull else { continue }
            path.append(UIBezierPath(roundedRect: converted, cornerRadius: 3))
        }
        // Silent: a layer path change animates by default, and a highlight that
        // eases between words at reading speed looks like lag.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        overlay.path = path.cgPath
        CATransaction.commit()
    }

    /// "Needs column-aware auto-scroll and page advance to keep the spoken word
    /// visible." Column-awareness comes for free from following the boxes
    /// themselves: the second column's boxes are up and to the right, and
    /// scrolling to them does the right thing without knowing they are a column.
    private func scrollIfNeeded() {
        guard
            let span = currentSpan,
            let document,
            span.pageIndex >= 0, span.pageIndex < document.pageCount,
            let page = document.page(at: span.pageIndex),
            let box = span.bboxes.first
        else { return }

        if currentPage !== page {
            go(to: page)
        }

        let converted = convert(box, from: page)
        let comfortable = bounds.insetBy(dx: 0, dy: bounds.height * 0.22)
        guard !comfortable.contains(converted) else { return }
        // `go(to:on:)` centres the rect, which is what is wanted when the word
        // has scrolled off, and a no-op when it has not.
        go(to: box.insetBy(dx: -40, dy: -80), on: page)
    }
}

extension CGRect {
    var isFinite: Bool {
        origin.x.isFinite && origin.y.isFinite && size.width.isFinite && size.height.isFinite
    }
}
