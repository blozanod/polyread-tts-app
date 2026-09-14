import Foundation
import PolyReadCore

/// §7.1 — "`Voices.bin`: 24-byte header (magic `"AIOSVOX"` + version byte, count,
/// lengths=510, dimension=256, reserved), then `24·n` NUL-padded ASCII names,
/// then `count · 510 · 256` float32 LE. **Style row index = phoneme count
/// excluding the two boundary tokens.**"
public struct VoicesBin: Sendable {

    public struct Header: Sendable, Equatable {
        public let version: UInt8
        public let count: Int
        public let lengths: Int      // 510
        public let dimension: Int    // 256
    }

    public let header: Header
    public let names: [String]
    /// Flat: `voice * lengths * dimension + row * dimension + component`.
    private let styles: [Float]

    static let magic = "AIOSVOX"
    static let headerSize = 24
    static let nameSize = 24

    public init(data: Data) throws {
        guard data.count >= Self.headerSize else {
            throw PolyReadError.voicesFileMalformed("file is \(data.count) bytes, shorter than the header")
        }

        let magic = String(decoding: data[0..<7], as: UTF8.self)
        guard magic == Self.magic else {
            throw PolyReadError.voicesFileMalformed("magic is \"\(magic)\", expected \"\(Self.magic)\"")
        }

        let version = data[data.startIndex + 7]
        let count = Int(Self.readUInt32(data, at: 8))
        let lengths = Int(Self.readUInt32(data, at: 12))
        let dimension = Int(Self.readUInt32(data, at: 16))

        guard count > 0, lengths > 0, dimension > 0 else {
            throw PolyReadError.voicesFileMalformed("count=\(count) lengths=\(lengths) dimension=\(dimension)")
        }

        let namesSize = count * Self.nameSize
        let floatCount = count * lengths * dimension
        let expected = Self.headerSize + namesSize + floatCount * MemoryLayout<Float>.size
        guard data.count >= expected else {
            throw PolyReadError.voicesFileMalformed(
                "file is \(data.count) bytes, expected at least \(expected) for \(count) voices"
            )
        }

        var names: [String] = []
        names.reserveCapacity(count)
        for i in 0..<count {
            let start = data.startIndex + Self.headerSize + i * Self.nameSize
            let bytes = data[start..<(start + Self.nameSize)]
            let trimmed = bytes.prefix { $0 != 0 }
            names.append(String(decoding: trimmed, as: UTF8.self))
        }

        let floatStart = data.startIndex + Self.headerSize + namesSize
        var styles = [Float](repeating: 0, count: floatCount)
        styles.withUnsafeMutableBytes { destination in
            data.copyBytes(
                to: destination.bindMemory(to: UInt8.self),
                from: floatStart..<(floatStart + floatCount * MemoryLayout<Float>.size)
            )
        }
        // The file is little-endian and every device this runs on is too, so the
        // copy above is already correct; there is nothing to byte-swap.

        self.header = Header(version: version, count: count, lengths: lengths, dimension: dimension)
        self.names = names
        self.styles = styles
    }

    public init(url: URL) throws {
        try self.init(data: try Data(contentsOf: url, options: .mappedIfSafe))
    }

    public static func bundled(bundle: Bundle = .main) throws -> VoicesBin {
        guard let url = bundle.url(forResource: "Voices", withExtension: "bin") else {
            throw PolyReadError.modelMissing("Voices.bin")
        }
        return try VoicesBin(url: url)
    }

    /// The style vector for a voice at a given phoneme count.
    ///
    /// §7.1's rule is that the row index *is* the phoneme count with the two
    /// boundary zeros excluded — which is also why §6.2 wants uniform chunk
    /// lengths: wildly varying counts pick wildly varying style rows and the
    /// prosody wanders.
    public func style(voice name: String, phonemeCount: Int) throws -> [Float] {
        guard let index = names.firstIndex(of: name) else {
            throw PolyReadError.voiceNotFound(name)
        }
        // A chunk exactly at the 510 budget would index one past the last row.
        let row = min(max(0, phonemeCount), header.lengths - 1)
        let start = (index * header.lengths + row) * header.dimension
        return Array(styles[start..<(start + header.dimension)])
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        let start = data.startIndex + offset
        var value: UInt32 = 0
        for i in 0..<4 {
            value |= UInt32(data[start + i]) << (8 * UInt32(i))
        }
        return value
    }
}
