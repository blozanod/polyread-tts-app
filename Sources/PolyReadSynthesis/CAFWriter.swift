import Foundation
import PolyReadCore

/// §7.4 — "Int16 CAF per document — no encode latency, seekable, ~260 MB per 90
/// minutes."
///
/// Random-access rather than append-only, which §7.2 makes possible and §7.3
/// makes necessary. Phase A computes the exact frame offset of every chunk
/// before any audio exists, so the file can be created at its final length and
/// chunks written wherever they belong, in any order. That is what lets §7.3's
/// "seek into unrendered territory" work: render the one chunk under the
/// playhead, write it at its own offset, start there — no shuffling, no second
/// file, no waiting for Phase B to catch up.
///
/// Written by hand rather than through `AVAudioFile` because `AVAudioFile`
/// truncates on open, so a document half-rendered when the app was killed would
/// start over.
public final class CAFWriter {

    public let url: URL
    public let totalFrames: Int
    private let handle: FileHandle

    /// CAF's own header fields are big-endian; the
    /// `kCAFLinearPCMFormatFlagIsLittleEndian` bit (1 << 1) then declares the
    /// *samples* little-endian, which is what the device reads back fastest.
    static let formatFlagsLittleEndianInteger: UInt32 = 2

    /// Creates, or reopens, a file sized for the whole document. Unwritten
    /// regions read as silence, and the file is sparse until they are written.
    public init(url: URL, totalFrames: Int) throws {
        self.url = url
        self.totalFrames = totalFrames

        let fileManager = FileManager.default
        let existingSize = (try? fileManager.attributesOfItem(atPath: url.path))
            .flatMap { $0[.size] as? Int } ?? 0
        let requiredSize = Self.audioStartOffset + Self.byteCount(frames: totalFrames)

        if existingSize >= requiredSize, let handle = try? FileHandle(forUpdating: url) {
            self.handle = handle
        } else {
            fileManager.createFile(atPath: url.path, contents: nil)
            guard let handle = try? FileHandle(forUpdating: url) else {
                throw PolyReadError.cacheWriteFailed("could not create \(url.lastPathComponent)")
            }
            self.handle = handle
            try handle.write(contentsOf: Self.container(frames: totalFrames))
            try handle.truncate(atOffset: UInt64(requiredSize))
        }
    }

    /// `audio [1, F·600]` fp32 out of the acoustic model, Int16 on disk.
    public func write(samples: [Float], atFrame frame: Int) throws {
        guard !samples.isEmpty else { return }
        let offset = Self.audioStartOffset + Self.byteCount(frames: frame)
        let capacity = Self.byteCount(frames: max(0, totalFrames - frame))

        var bytes = Data(capacity: min(samples.count * MemoryLayout<Int16>.size, capacity))
        for sample in samples {
            guard bytes.count + MemoryLayout<Int16>.size <= capacity else { break }
            // Clamp before scaling: the model occasionally overshoots ±1.0, and
            // wrapping a peak turns it into a click.
            let clamped = max(-1.0, min(1.0, sample))
            let value = Int16(clamping: Int(clamped * 32767.0))
            withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) }
        }

        try handle.seek(toOffset: UInt64(offset))
        try handle.write(contentsOf: bytes)
    }

    public func close() throws {
        try handle.synchronize()
        try handle.close()
    }

    // MARK: - Container

    static func byteCount(frames: Int) -> Int {
        FrameMath.samples(frames: frames) * MemoryLayout<Int16>.size
    }

    static let headerSize = 8               // 'caff' + version + flags
    static let descChunkSize = 12 + 32      // 'desc' + Int64 size + CAFAudioFormat
    /// Past the file header, the desc chunk, the 'data' fourcc, its Int64 size
    /// and mEditCount.
    static var audioStartOffset: Int { headerSize + descChunkSize + 4 + 8 + 4 }

    static func container(frames: Int) -> Data {
        var data = Data()
        data.append(contentsOf: Array("caff".utf8))
        data.append(bigEndian: UInt16(1))    // version
        data.append(bigEndian: UInt16(0))    // flags

        data.append(contentsOf: Array("desc".utf8))
        data.append(bigEndian: Int64(32))
        data.append(bigEndian: FrameMath.sampleRate.bitPattern)
        data.append(contentsOf: Array("lpcm".utf8))
        data.append(bigEndian: formatFlagsLittleEndianInteger)
        data.append(bigEndian: UInt32(2))    // bytes per packet
        data.append(bigEndian: UInt32(1))    // frames per packet
        data.append(bigEndian: UInt32(1))    // channels
        data.append(bigEndian: UInt32(16))   // bits per channel

        data.append(contentsOf: Array("data".utf8))
        // Size covers mEditCount plus every audio byte. Known up front, because
        // Phase A knows the document's exact length before any audio exists.
        data.append(bigEndian: Int64(4 + byteCount(frames: frames)))
        data.append(bigEndian: UInt32(0))    // mEditCount
        return data
    }
}

private extension Data {
    mutating func append<T: FixedWidthInteger>(bigEndian value: T) {
        var swapped = value.bigEndian
        withUnsafeBytes(of: &swapped) { append(contentsOf: $0) }
    }
}
