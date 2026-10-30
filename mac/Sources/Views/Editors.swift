import AppKit
import SwiftUI

/// Rendered Markdown that turns into a plain-text editor on the pencil button or a double-click.
struct MarkdownEditor: View {
    let value: String?
    var placeholder = "Add a description…"
    var minHeight: CGFloat = 140
    let onSave: (String) -> Void

    @State private var draft = ""
    @State private var editing = false
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if editing {
                VStack(alignment: .leading, spacing: 8) {
                    TextEditor(text: $draft)
                        .font(.system(size: 13, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .scrollDisabled(true)
                        .frame(minHeight: minHeight)
                        .padding(8)
                        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.4)))
                        .focused($focused)
                    HStack(spacing: 8) {
                        Button("Save") { save() }
                            .keyboardShortcut(.return, modifiers: .command)
                        Button("Cancel") { editing = false }
                        Text("Markdown: # heading, - list, - [ ] checklist, **bold**, `code`  ·  ⌘↩ saves")
                            .foregroundStyle(.tertiary)
                    }
                    .font(.caption)
                }
            } else if (value ?? "").isEmpty {
                Button(action: start) {
                    Text(placeholder).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            } else {
                MarkdownView(text: value ?? "")
                    .padding(.trailing, 28)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2, perform: start)
                    .overlay(alignment: .topTrailing) {
                        Button(action: start) { Image(systemName: "pencil") }
                            .buttonStyle(.borderless)
                            .help("Edit (or double-click)")
                            .opacity(hovering ? 1 : 0.35)
                    }
                    .onHover { hovering = $0 }
            }
        }
        .onChange(of: value) { _, new in if !editing { draft = new ?? "" } }
    }

    private func start() {
        draft = value ?? ""
        editing = true
        focused = true
    }

    private func save() {
        if draft != (value ?? "") { onSave(draft) }
        editing = false
    }
}

/// Editable list of repos: name, GitHub URL and local checkout path.
struct RepoListEditor: View {
    let repos: [Repo]
    let onSave: ([Repo]) -> Void

    @State private var rows: [Repo] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(rows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    TextField("Name", text: field(i, \.name)).frame(width: 130)
                    TextField("https://github.com/org/repo", text: optional(i, \.url))
                    TextField("~/Developer/projects/repo", text: optional(i, \.path))
                    Button { choosePath(i) } label: { Image(systemName: "folder") }
                        .buttonStyle(.borderless)
                        .help("Choose local checkout")
                    if let url = rows[i].url.flatMap(URL.init(string:)), url.scheme?.hasPrefix("http") == true {
                        Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                            .help("Open on GitHub")
                    }
                    Button { rows.remove(at: i); commit() } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                }
                .textFieldStyle(.roundedBorder)
                .onSubmit(commit)
            }
            Button {
                rows.append(Repo(name: "", url: nil, path: nil))
            } label: {
                Label("Add repo", systemImage: "plus")
            }
            .buttonStyle(.borderless)
            .font(.callout)
        }
        .onAppear { rows = repos }
        .onChange(of: repos) { _, new in rows = new }
    }

    private func field(_ i: Int, _ key: WritableKeyPath<Repo, String>) -> Binding<String> {
        Binding(get: { rows.indices.contains(i) ? rows[i][keyPath: key] : "" },
                set: { if rows.indices.contains(i) { rows[i][keyPath: key] = $0 } })
    }

    private func optional(_ i: Int, _ key: WritableKeyPath<Repo, String?>) -> Binding<String> {
        Binding(get: { rows.indices.contains(i) ? rows[i][keyPath: key] ?? "" : "" },
                set: { if rows.indices.contains(i) { rows[i][keyPath: key] = $0.isEmpty ? nil : $0 } })
    }

    private func choosePath(_ i: Int) {
        guard let url = FolderPicker.choose() else { return }
        rows[i].path = FolderPicker.tildePath(url)
        if rows[i].name.isEmpty { rows[i].name = url.lastPathComponent }
        commit()
    }

    /// Saves named rows; a row without a name is still being filled in.
    private func commit() {
        let named = rows.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        if named != repos { onSave(named) }
    }
}

enum FolderPicker {
    static func choose() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Developer")
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func tildePath(_ url: URL) -> String {
        url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }
}

extension Repo {
    var json: [String: Any] {
        var out: [String: Any] = ["name": name]
        if let url { out["url"] = url }
        if let path { out["path"] = path }
        return out
    }
}
