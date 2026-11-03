import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Screenshots and files on tasks and comments: paste (⌘V), drop, or pick them with the paperclip. They're
// uploaded with the task or comment and the runner hands them to the agent as files it can open.

extension PendingFile {
    /// Images stay well under the bucket's limit; bigger ones are re-encoded as JPEG.
    private static let maxBytes = 15 * 1024 * 1024
    /// The bucket's limit (the project's 50 MB upload cap); other files over it are refused up front.
    static let maxFileBytes = 50 * 1024 * 1024
    private static let kept: [String: String] = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                                                 "gif": "image/gif", "webp": "image/webp"]

    /// What a pasteboard holds to attach: files first (copied in Finder, or dropped), then raw image data
    /// (screenshots). Plain text wins over raw data, so pasting text that carries a picture stays text.
    static func read(from pasteboard: NSPasteboard) -> [PendingFile] {
        let urls = (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
            .filter { !$0.hasDirectoryPath }
        if !urls.isEmpty { return urls.compactMap(from(file:)) }
        if pasteboard.string(forType: .string) != nil { return [] }
        if let png = pasteboard.data(forType: .png) { return make(png, name: "Screenshot", ext: "png").map { [$0] } ?? [] }
        if let tiff = pasteboard.data(forType: .tiff) { return make(tiff, name: "Screenshot", ext: "tiff").map { [$0] } ?? [] }
        return []
    }

    static func from(file url: URL) -> PendingFile? {
        let name = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension.lowercased()
        let type = UTType(filenameExtension: ext)
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let isImage = type?.conforms(to: .image) ?? false
        if !isImage, size > maxFileBytes {
            Task { @MainActor in BoardStore.shared.report("\(url.lastPathComponent) is over 50 MB, too big to attach.") }
            return nil
        }
        guard let data = try? Data(contentsOf: url) else { return nil }
        if isImage, let image = make(data, name: name, ext: ext) { return image }
        guard data.count <= maxFileBytes else { return nil }
        return PendingFile(data: data, type: type?.preferredMIMEType ?? "application/octet-stream", ext: ext,
                           name: url.lastPathComponent, preview: NSWorkspace.shared.icon(forFile: url.path))
    }

    /// Keeps PNG/JPEG/GIF/WebP as they are; anything else (TIFF, HEIC, …) becomes PNG so every viewer can open it.
    static func make(_ data: Data, name: String, ext: String) -> PendingFile? {
        guard let image = NSImage(data: data) else { return nil }
        if let type = kept[ext], data.count <= maxBytes {
            return PendingFile(data: data, type: type, ext: ext == "jpeg" ? "jpg" : ext, name: "\(name).\(ext)", preview: image)
        }
        guard let rep = NSBitmapImageRep(data: data) ?? image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) else { return nil }
        if let png = rep.representation(using: .png, properties: [:]), png.count <= maxBytes {
            return PendingFile(data: png, type: "image/png", ext: "png", name: "\(name).png", preview: image)
        }
        guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return nil }
        return PendingFile(data: jpg, type: "image/jpeg", ext: "jpg", name: "\(name).jpg", preview: image)
    }
}

/// A plain-text editor that turns pasted or dropped screenshots and files into attachments instead of ignoring them.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var fontSize: CGFloat = 14
    var onImages: ([PendingFile]) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = PastingTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let view = scroll.documentView as! NSTextView
        let pasting = PastingTextView(frame: view.frame, textContainer: view.textContainer)
        pasting.autoresizingMask = view.autoresizingMask
        pasting.minSize = view.minSize
        pasting.maxSize = view.maxSize
        pasting.isVerticallyResizable = true
        pasting.isHorizontallyResizable = false
        pasting.isRichText = false
        pasting.allowsUndo = true
        pasting.drawsBackground = false
        pasting.isAutomaticQuoteSubstitutionEnabled = false
        pasting.isAutomaticDashSubstitutionEnabled = false
        pasting.textContainerInset = .zero
        pasting.font = .systemFont(ofSize: fontSize)
        pasting.textColor = .labelColor
        pasting.delegate = context.coordinator
        pasting.registerForDraggedTypes(pasting.registeredDraggedTypes + [.fileURL, .png, .tiff])
        scroll.documentView = pasting
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? PastingTextView else { return }
        view.onImages = onImages
        if view.string != text { view.string = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        init(parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
        }
    }
}

final class PastingTextView: NSTextView {
    var onImages: (([PendingFile]) -> Void)?

    override func paste(_ sender: Any?) {
        let images = PendingFile.read(from: .general)
        if images.isEmpty { super.paste(sender) } else { onImages?(images) }
    }

    // A plain-text view greys out Paste when the clipboard holds only an image.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), !PendingFile.read(from: .general).isEmpty { return true }
        return super.validateUserInterfaceItem(item)
    }

    private func hasImages(_ info: NSDraggingInfo) -> Bool { !PendingFile.read(from: info.draggingPasteboard).isEmpty }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        hasImages(sender) ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        hasImages(sender) ? .copy : super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let images = PendingFile.read(from: sender.draggingPasteboard)
        guard !images.isEmpty else { return super.performDragOperation(sender) }
        onImages?(images)
        return true
    }
}

/// Paperclip: pick files to attach.
struct AttachFilesButton: View {
    var onImages: ([PendingFile]) -> Void

    var body: some View {
        Button {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = true
            panel.canChooseDirectories = false
            guard panel.runModal() == .OK else { return }
            onImages(panel.urls.compactMap(PendingFile.from(file:)))
        } label: {
            Image(systemName: "paperclip")
        }
        .buttonStyle(.borderless)
        .help("Attach files (or paste a screenshot with ⌘V, or drop files in the box)")
    }
}

/// Thumbnails of screenshots and files waiting to be sent, each with a remove button.
struct PendingFilesStrip: View {
    @Binding var images: [PendingFile]

    var body: some View {
        if !images.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(images) { file in
                        tile(file)
                            .frame(width: 72, height: 72)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.25)))
                            .overlay(alignment: .topTrailing) {
                                Button { images.removeAll { $0.id == file.id } } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .buttonStyle(.plain)
                                .padding(3)
                                .help("Remove")
                            }
                            .help(file.name)
                    }
                }
            }
        }
    }

    @ViewBuilder private func tile(_ file: PendingFile) -> some View {
        if file.isImage {
            Image(nsImage: file.preview).resizable().scaledToFill()
        } else {
            VStack(spacing: 3) {
                Image(nsImage: file.preview).resizable().scaledToFit().frame(width: 36, height: 36)
                Text(file.name).font(.system(size: 9)).lineLimit(2).multilineTextAlignment(.center)
                    .truncationMode(.middle).foregroundStyle(.secondary)
            }
            .padding(4)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.secondary.opacity(0.08))
        }
    }
}

/// Stored screenshots (inline) and files (as chips). The bucket is private, so they load through the
/// store with the service key.
struct AttachmentList: View {
    let attachments: [FileAttachment]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(attachments, id: \.path) { a in
                if a.isImage { StoredImage(attachment: a) } else { StoredFile(attachment: a) }
            }
        }
    }
}

private struct StoredFile: View {
    let attachment: FileAttachment
    var store = BoardStore.shared

    var body: some View {
        Button { store.openFile(attachment) } label: {
            HStack(spacing: 6) {
                let ext = (attachment.name as NSString).pathExtension
                Image(nsImage: NSWorkspace.shared.icon(for: UTType(filenameExtension: ext) ?? .data))
                    .resizable().frame(width: 20, height: 20)
                Text(attachment.name).lineLimit(1).truncationMode(.middle)
            }
            .font(.callout)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: 260, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
        }
        .buttonStyle(.plain)
        .help("\(attachment.name) — click to open")
    }
}

private struct StoredImage: View {
    let attachment: FileAttachment
    var store = BoardStore.shared
    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                ZStack {
                    Color.secondary.opacity(0.1)
                    if failed { Image(systemName: "photo").foregroundStyle(.tertiary) } else { ProgressView().controlSize(.small) }
                }
            }
        }
        .frame(maxWidth: 220, maxHeight: 160)
        .frame(minWidth: 60, minHeight: 60)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
        .contentShape(Rectangle())
        .onTapGesture { store.openFile(attachment) }
        .help("\(attachment.name) — click to open")
        .task(id: attachment.path) {
            image = await store.image(at: attachment.path)
            failed = image == nil
        }
    }
}
