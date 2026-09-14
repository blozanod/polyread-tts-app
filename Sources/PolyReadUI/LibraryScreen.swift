import SwiftUI
import UniformTypeIdentifiers
import PolyReadCore
import PolyReadSynthesis

/// §11 — "no library beyond recently-opened."
public struct LibraryScreen: View {

    @ObservedObject var session: DocumentSession
    @State private var showingPicker = false
    @State private var entries: [DocumentCache.Entry] = []
    @State private var showingSettings = false

    public init(session: DocumentSession) {
        self.session = session
    }

    public var body: some View {
        List {
            if entries.isEmpty {
                ContentUnavailableView {
                    Label("No readings yet", systemImage: "doc.text")
                } description: {
                    Text("Open a PDF from Files, or use “Open in PolyRead” from Safari or Mail.")
                } actions: {
                    Button("Open a PDF") { showingPicker = true }
                }
                .listRowSeparator(.hidden)
            }

            ForEach(entries) { entry in
                Button {
                    // Reopening goes through the cache by content hash, so this
                    // is instant for anything already imported (§7.4).
                    session.reopen(entry: entry)
                } label: {
                    LibraryRow(entry: entry)
                }
                .buttonStyle(.plain)
            }
            .onDelete { offsets in
                for index in offsets {
                    session.forget(hash: entries[index].contentHash)
                }
                reload()
            }
        }
        .listStyle(.plain)
        .navigationTitle("PolyRead")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingPicker = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Open a PDF")
            }
            ToolbarItem(placement: .topBarLeading) {
                Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack { SettingsScreen(session: session) }
        }
        // §1 — "a `UIDocumentPickerViewController`. That covers 'Open in
        // PolyRead' from Files, Safari, and Mail with no share-extension target
        // and no App Group."
        .fileImporter(isPresented: $showingPicker, allowedContentTypes: [.pdf]) { result in
            if case .success(let url) = result { session.open(url: url) }
        }
        .task { reload() }
        .onChange(of: session.stage) { _, _ in reload() }
    }

    private func reload() {
        entries = session.libraryEntries()
    }
}

struct LibraryRow: View {
    let entry: DocumentCache.Entry

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: entry.isComplete ? "waveform.circle.fill" : "waveform.circle")
                .font(.title2)
                .foregroundStyle(entry.isComplete ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title).font(.body)
                Text(
                    "\(entry.pageCount) pages · \(TransportBar.timestamp(entry.duration))"
                    + (entry.isComplete ? "" : " · still rendering")
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

/// §7.4 — "a user-visible storage figure in settings."
public struct SettingsScreen: View {

    @ObservedObject var session: DocumentSession
    @Environment(\.dismiss) private var dismiss
    @State private var storageBytes = 0

    public init(session: DocumentSession) {
        self.session = session
    }

    public var body: some View {
        Form {
            Section("Audio cache") {
                LabeledContent("Used", value: Self.format(bytes: storageBytes))
                LabeledContent("Limit", value: Self.format(bytes: session.settings.cacheByteLimit))
                Button("Clear cache", role: .destructive) {
                    session.clearCache()
                    storageBytes = session.cacheBytes()
                }
            }

            Section {
                Picker("Acoustic model placement", selection: $session.settings.acousticComputeUnits) {
                    ForEach(AcousticPlacement.allCases, id: \.self) { placement in
                        Text(placement.label).tag(placement)
                    }
                }
                NavigationLink("Run the §0 benchmark") {
                    BenchmarkScreen(settings: $session.settings)
                }
            } header: {
                Text("Synthesis")
            } footer: {
                // §0.2, stated where the setting is, because the consequence is
                // not obvious from the name.
                Text(
                    session.settings.acousticComputeUnits.keepsRenderingInBackground
                    ? "CPU only: rendering continues while the app is in the background."
                    : "Rendering pauses when the app is backgrounded, because iOS does not let a backgrounded app submit Metal work."
                )
            }

            Section("Playback") {
                LabeledContent("Voice", value: session.settings.voiceName)
                LabeledContent("Buffer before playing", value: "\(Int(session.settings.initialAudioLead))s")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") {
                    session.settings.save()
                    dismiss()
                }
            }
        }
        .task { storageBytes = session.cacheBytes() }
    }

    static func format(bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
