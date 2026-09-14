import Testing
import Foundation
@testable import PolyReadSynthesis
import PolyReadCore

@Suite("§7.1 Voices.bin")
struct VoicesBinTests {

    /// Builds a file to the §7.1 layout: 24-byte header, 24·n names, then
    /// count · lengths · dimension float32 LE.
    private func makeFile(
        names: [String],
        lengths: Int = 4,
        dimension: Int = 3,
        magic: String = "AIOSVOX"
    ) -> Data {
        var data = Data()
        data.append(contentsOf: Array(magic.utf8).prefix(7))
        while data.count < 7 { data.append(0) }
        data.append(1)                                          // version
        for value in [UInt32(names.count), UInt32(lengths), UInt32(dimension), 0] {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        for name in names {
            var bytes = Array(name.utf8).prefix(24).map { $0 }
            bytes.append(contentsOf: [UInt8](repeating: 0, count: 24 - bytes.count))
            data.append(contentsOf: bytes)
        }
        for voice in 0..<names.count {
            for row in 0..<lengths {
                for component in 0..<dimension {
                    let value = Float(voice * 1000 + row * 10 + component)
                    withUnsafeBytes(of: value.bitPattern.littleEndian) { data.append(contentsOf: $0) }
                }
            }
        }
        return data
    }

    @Test("parses header, names and style rows")
    func parses() throws {
        let voices = try VoicesBin(data: makeFile(names: ["af_heart", "am_michael"]))
        #expect(voices.header.count == 2)
        #expect(voices.header.lengths == 4)
        #expect(voices.header.dimension == 3)
        #expect(voices.names == ["af_heart", "am_michael"])
    }

    /// §7.1 — "**Style row index = phoneme count excluding the two boundary
    /// tokens.**"
    @Test("the style row is the phoneme count")
    func styleRowIsPhonemeCount() throws {
        let voices = try VoicesBin(data: makeFile(names: ["af_heart", "am_michael"]))
        #expect(try voices.style(voice: "af_heart", phonemeCount: 2) == [20, 21, 22])
        #expect(try voices.style(voice: "am_michael", phonemeCount: 0) == [1000, 1001, 1002])
    }

    /// A chunk exactly at the 510 budget would index one row past the end.
    @Test("the row index is clamped to the table")
    func clampsRow() throws {
        let voices = try VoicesBin(data: makeFile(names: ["af_heart"]))
        #expect(try voices.style(voice: "af_heart", phonemeCount: 99) == [30, 31, 32])
        #expect(try voices.style(voice: "af_heart", phonemeCount: -5) == [0, 1, 2])
    }

    @Test("a bad magic or a truncated file is an error, not garbage")
    func rejectsMalformed() {
        #expect(throws: PolyReadError.self) {
            _ = try VoicesBin(data: makeFile(names: ["af_heart"], magic: "NOTVOX!"))
        }
        #expect(throws: PolyReadError.self) {
            _ = try VoicesBin(data: makeFile(names: ["af_heart"]).prefix(60))
        }
        #expect(throws: PolyReadError.self) {
            _ = try VoicesBin(data: Data())
        }
    }

    @Test("an unknown voice name is an error")
    func unknownVoice() throws {
        let voices = try VoicesBin(data: makeFile(names: ["af_heart"]))
        #expect(throws: PolyReadError.self) {
            _ = try voices.style(voice: "nobody", phonemeCount: 1)
        }
    }
}
