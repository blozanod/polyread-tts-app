import Foundation

/// §5 — "`Block.spans.count == Block.spokenText.split(separator: " ").count`,
/// index-aligned, is the invariant the entire highlight mechanism rests on."
///
/// §12 — "Shared invariant to test in every agent's debug build."
///
/// If this breaks, highlighting drifts silently and the bug looks like a timing
/// bug. So it is checked loudly, at every stage boundary, in debug builds only.
public enum SpanInvariant {

    /// Whitespace-split tokens of a block's spoken text. This is *the* definition
    /// of "spoken token" for the whole codebase — the phonemizer, the chunker and
    /// the timeline all split the same way, or the alignment is meaningless.
    public static func tokens(of spokenText: String) -> [Substring] {
        spokenText.split(whereSeparator: { $0.isWhitespace })
    }

    public static func holds(for block: Block) -> Bool {
        tokens(of: block.spokenText).count == block.spans.count
    }

    /// Debug-build assertion. `stage` names the pass that produced the block so a
    /// failure points at the culprit rather than at the consumer.
    public static func check(
        _ block: Block,
        stage: @autoclosure () -> String,
        file: StaticString = #fileID,
        line: UInt = #line
    ) {
        #if DEBUG
        let tokenCount = tokens(of: block.spokenText).count
        assert(
            tokenCount == block.spans.count,
            """
            Span invariant broken after \(stage()).
            Block \(block.id) role=\(block.role.rawValue)
            \(tokenCount) spoken tokens vs \(block.spans.count) spans.
            text: \(block.spokenText.prefix(240))
            """,
            file: file,
            line: line
        )
        #endif
    }

    public static func check(
        _ blocks: [Block],
        stage: @autoclosure () -> String,
        file: StaticString = #fileID,
        line: UInt = #line
    ) {
        #if DEBUG
        let label = stage()
        for block in blocks {
            check(block, stage: label, file: file, line: line)
        }
        #endif
    }

    /// Non-fatal form, for the import path: a malformed PDF should surface a
    /// diagnostic rather than trap a release build.
    public static func violations(in blocks: [Block]) -> [String] {
        blocks.compactMap { block in
            let tokenCount = tokens(of: block.spokenText).count
            guard tokenCount != block.spans.count else { return nil }
            return "\(block.role.rawValue) \(block.id): \(tokenCount) tokens vs \(block.spans.count) spans"
        }
    }
}
