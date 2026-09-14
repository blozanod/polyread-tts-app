import Foundation
import CryptoKit
import PolyReadCore

/// §7.4 — "Keyed by PDF content hash so reopening a document is instant. LRU
/// eviction of whole documents against a size cap (default ~4 GB), with a
/// user-visible storage figure in settings."
public struct DocumentCache: Sendable {

    public struct Entry: Sendable, Codable, Identifiable {
        public let contentHash: String
        public let title: String
        public let pageCount: Int
        public let duration: TimeInterval
        public var lastOpened: Date
        public var byteSize: Int
        public var isComplete: Bool

        public var id: String { contentHash }
    }

    public let root: URL
    /// §7.4 — "a size cap (default ~4 GB)".
    public let byteLimit: Int

    public init(root: URL? = nil, byteLimit: Int = 4 * 1024 * 1024 * 1024) throws {
        let base = try root ?? FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("PolyRead/Cache", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        self.root = base
        self.byteLimit = byteLimit
    }

    // MARK: Keys

    /// Content hash, not path: the same reading opened from Files and from Mail
    /// is one cache entry, and a re-download with a new name is still a hit.
    /// Hashed in chunks so a 200 MB scan does not have to be resident.
    public static func contentHash(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1 << 20), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func directory(for hash: String) -> URL {
        root.appendingPathComponent(hash, isDirectory: true)
    }

    public func audioURL(for hash: String) -> URL {
        directory(for: hash).appendingPathComponent("audio.caf")
    }

    func sidecarURL(for hash: String) -> URL {
        directory(for: hash).appendingPathComponent("sidecar.json")
    }

    func progressURL(for hash: String) -> URL {
        directory(for: hash).appendingPathComponent("progress.json")
    }

    func indexURL() -> URL {
        root.appendingPathComponent("index.json")
    }

    // MARK: Read / write

    public func prepareDirectory(for hash: String) throws {
        try FileManager.default.createDirectory(at: directory(for: hash), withIntermediateDirectories: true)
    }

    public func sidecar(for hash: String) -> DocumentSidecar? {
        guard let data = try? Data(contentsOf: sidecarURL(for: hash)),
              let sidecar = try? JSONDecoder().decode(DocumentSidecar.self, from: data)
        else { return nil }
        // A sidecar written by an older pipeline describes audio this build would
        // not produce. Replaying it against fresh audio drifts silently, so it is
        // treated as a miss.
        guard sidecar.version == DocumentSidecar.currentVersion else { return nil }
        return sidecar
    }

    public func save(sidecar: DocumentSidecar) throws {
        try prepareDirectory(for: sidecar.contentHash)
        let data = try JSONEncoder().encode(sidecar)
        try data.write(to: sidecarURL(for: sidecar.contentHash), options: .atomic)
    }

    public func progress(for hash: String) -> RenderProgress? {
        guard let data = try? Data(contentsOf: progressURL(for: hash)) else { return nil }
        return try? JSONDecoder().decode(RenderProgress.self, from: data)
    }

    public func save(progress: RenderProgress, for hash: String) throws {
        try prepareDirectory(for: hash)
        let data = try JSONEncoder().encode(progress)
        try data.write(to: progressURL(for: hash), options: .atomic)
    }

    // MARK: Index and eviction

    public func entries() -> [Entry] {
        guard let data = try? Data(contentsOf: indexURL()),
              let entries = try? JSONDecoder().decode([Entry].self, from: data)
        else { return [] }
        return entries.sorted { $0.lastOpened > $1.lastOpened }
    }

    public func touch(
        hash: String,
        title: String,
        pageCount: Int,
        duration: TimeInterval,
        isComplete: Bool
    ) throws {
        var all = entries().filter { $0.contentHash != hash }
        all.append(
            Entry(
                contentHash: hash,
                title: title,
                pageCount: pageCount,
                duration: duration,
                lastOpened: Date(),
                byteSize: byteSize(of: hash),
                isComplete: isComplete
            )
        )
        try write(index: all)
    }

    func write(index: [Entry]) throws {
        let data = try JSONEncoder().encode(index)
        try data.write(to: indexURL(), options: .atomic)
    }

    public func byteSize(of hash: String) -> Int {
        let manager = FileManager.default
        guard let contents = try? manager.contentsOfDirectory(
            at: directory(for: hash),
            includingPropertiesForKeys: [.fileAllocatedSizeKey]
        ) else { return 0 }
        return contents.reduce(0) { total, url in
            // Allocated, not logical: the CAF is created at full length and is
            // sparse until Phase B fills it, so the logical size would report a
            // half-rendered document as though it were complete.
            let values = try? url.resourceValues(forKeys: [.fileAllocatedSizeKey])
            return total + (values?.fileAllocatedSize ?? 0)
        }
    }

    /// §7.4 — "a user-visible storage figure in settings."
    public func totalBytes() -> Int {
        entries().reduce(0) { $0 + byteSize(of: $1.contentHash) }
    }

    /// LRU eviction of *whole documents* — half a document's audio is worth
    /// nothing, so entries go out intact.
    @discardableResult
    public func evictIfNeeded(protecting protected: String? = nil) throws -> [String] {
        var all = entries()
        for index in all.indices {
            all[index].byteSize = byteSize(of: all[index].contentHash)
        }
        var total = all.reduce(0) { $0 + $1.byteSize }
        guard total > byteLimit else { return [] }

        var evicted: [String] = []
        // Oldest first.
        for entry in all.sorted(by: { $0.lastOpened < $1.lastOpened }) {
            guard total > byteLimit else { break }
            guard entry.contentHash != protected else { continue }
            try? FileManager.default.removeItem(at: directory(for: entry.contentHash))
            total -= entry.byteSize
            evicted.append(entry.contentHash)
        }

        try write(index: all.filter { !evicted.contains($0.contentHash) })
        return evicted
    }

    public func remove(hash: String) throws {
        try? FileManager.default.removeItem(at: directory(for: hash))
        try write(index: entries().filter { $0.contentHash != hash })
    }
}
