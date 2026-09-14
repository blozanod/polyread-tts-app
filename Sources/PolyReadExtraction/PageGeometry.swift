import Foundation
import CoreGraphics

import PDFKit

/// Both backends have to land in the *same* coordinate space or §4.2–§4.6 would
/// need writing twice, which §4.1 explicitly forbids. That space is PDF user
/// space for the crop box, origin bottom-left — what `PDFPage.characterBounds`
/// already returns and what `PDFView.convert(_:from:)` expects for the §10 iPad
/// overlay.
///
/// Vision, though, sees a *rendered* page: rotation applied, normalized 0–1
/// coordinates. This maps back.
struct PageGeometry {
    let cropBox: CGRect
    /// PDF `/Rotate`, normalized to one of 0, 90, 180, 270. Clockwise.
    let rotation: Int

    /// Size of the page as rendered, in points.
    var displaySize: CGSize {
        (rotation == 90 || rotation == 270)
            ? CGSize(width: cropBox.height, height: cropBox.width)
            : cropBox.size
    }

    /// A point in rendered-image space (points, origin bottom-left) back to PDF
    /// user space.
    func pagePoint(fromDisplay p: CGPoint) -> CGPoint {
        let w = cropBox.width
        let h = cropBox.height
        let local: CGPoint
        switch rotation {
        case 90:  local = CGPoint(x: w - p.y, y: p.x)
        case 180: local = CGPoint(x: w - p.x, y: h - p.y)
        case 270: local = CGPoint(x: p.y, y: h - p.x)
        default:  local = p
        }
        return CGPoint(x: local.x + cropBox.minX, y: local.y + cropBox.minY)
    }

    /// Vision hands back normalized coordinates against the rendered image.
    func pageRect(fromNormalized r: CGRect) -> CGRect {
        let size = displaySize
        let corners = [
            CGPoint(x: r.minX * size.width, y: r.minY * size.height),
            CGPoint(x: r.maxX * size.width, y: r.minY * size.height),
            CGPoint(x: r.minX * size.width, y: r.maxY * size.height),
            CGPoint(x: r.maxX * size.width, y: r.maxY * size.height),
        ].map(pagePoint(fromDisplay:))

        let xs = corners.map(\.x)
        let ys = corners.map(\.y)
        return CGRect(
            x: xs.min() ?? 0,
            y: ys.min() ?? 0,
            width: (xs.max() ?? 0) - (xs.min() ?? 0),
            height: (ys.max() ?? 0) - (ys.min() ?? 0)
        )
    }

    init(page: PDFPage) {
        self.cropBox = page.bounds(for: .cropBox)
        var r = page.rotation % 360
        if r < 0 { r += 360 }
        self.rotation = (r / 90) * 90
    }

    init(cropBox: CGRect, rotation: Int = 0) {
        self.cropBox = cropBox
        var r = rotation % 360
        if r < 0 { r += 360 }
        self.rotation = (r / 90) * 90
    }
}
