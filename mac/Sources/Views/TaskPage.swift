import SwiftUI

/// Full-page issue view, Linear-style: content and timeline on the left, properties on the right.
struct TaskPage: View {
    let task: BoardTask
    /// Shown inside another view (the Inbox's detail pane): no back button or Esc, narrower properties.
    var embedded = false
    var store = BoardStore.shared

    @State private var title = ""
    @State private var comment = ""
    @State private var images: [PendingImage] = []
    @State private var newSubtask = ""
    @FocusState private var editingTitle: Bool
    @State private var scroller: ScrollViewProxy?

    var body: some View {
        HStack(spacing: 0) {
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    breadcrumb
                    TextField("Title", text: $title, axis: .vertical)
                        .font(.system(size: 24, weight: .semibold))
                        .textFieldStyle(.plain)
                        .focused($editingTitle)
                        .onSubmit(saveTitle)
                        .onChange(of: editingTitle) { _, focused in if !focused { saveTitle() } }

                    if embedded { CompactProperties(task: task) }
                    if task.status == .needs_you {
                        Button { withAnimation { scroller?.scrollTo("reply", anchor: .bottom) } } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "questionmark.bubble.fill").foregroundStyle(.orange)
                                Text("Waiting on you").fontWeight(.medium)
                                Text("Reply below").foregroundStyle(.secondary)
                                Image(systemName: "arrow.down").font(.caption).foregroundStyle(.secondary)
                            }
                            .font(.callout)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Color.orange.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    descriptionEditor
                    subtasks
                    dependencies
                    links
                    Divider()
                    timeline
                    if task.status == .needs_you { ReplyCard(task: task).id("reply") } else { composer }
                }
                .padding(.horizontal, embedded ? 28 : 40)
                .padding(.vertical, embedded ? 20 : 28)
                .frame(maxWidth: 820, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .onAppear { scroller = proxy }
            }

            // In the Inbox the properties sit in a strip under the title, leaving room to read.
            if !embedded {
                Divider()
                ScrollView {
                    TaskProperties(task: task)
                        .padding(20)
                }
                .frame(width: 290)
                .background(Color.secondary.opacity(0.04))
            }
        }
        .onAppear(perform: load)
        .onChange(of: task.id) { _, _ in load() }
        .onChange(of: task.title) { _, new in if !editingTitle { title = new } }
        .onExitCommand { if !embedded { store.selectedTaskId = nil } }
        .navigationTitle(embedded ? "Inbox" : task.key)
        .toolbar {
            if !embedded {
                ToolbarItem(placement: .navigation) {
                    Button { store.selectedTaskId = nil } label: { Image(systemName: "chevron.left") }
                        .help("Back (Esc)")
                }
            }
            if task.kind == .agent && task.status == .in_progress && Cmux.isInstalled {
                ToolbarItem {
                    Button { Cmux.openSession(taskId: task.id) } label: { Label("Open session", systemImage: "terminal") }
                }
            }
        }
    }

    private func load() {
        title = task.title
    }

    // MARK: Main column

    private var breadcrumb: some View {
        HStack(spacing: 6) {
            if let team = store.team(task.teamId) {
                Button(team.name) { store.teamFilter = team.id; store.section = .team(team.id); store.selectedTaskId = nil }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            if let project = task.project {
                ProjectTag(project: project)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            if let parent = task.parentId, let p = store.task(parent) {
                Button(p.title) { store.open(parent) }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            Text(task.key).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }

    private var descriptionEditor: some View {
        MarkdownEditor(value: task.description) { value in
            store.update(task, ["description": value]) { $0.description = value }
        }
        .id(task.id)
    }

    @ViewBuilder
    private var dependencies: some View {
        let blockers = store.blockers(of: task)
        let blocked = store.blocked(by: task.id)
        if !blockers.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionHeader(title: "Blocked by")
                ForEach(blockers) { TaskRow(task: $0, showDate: true, hideProject: task.project) }
            }
        }
        if !blocked.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                SectionHeader(title: "Blocks")
                ForEach(blocked) { TaskRow(task: $0, showDate: true, hideProject: task.project) }
            }
        }
    }

    private var subtasks: some View {
        let children = store.subtasks(of: task.id)
        return VStack(alignment: .leading, spacing: 4) {
            if !children.isEmpty {
                let done = children.filter { $0.status == .done }.count
                HStack {
                    SectionHeader(title: "Sub-tasks")
                    Text("\(done)/\(children.count)").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(children) { TaskRow(task: $0, showDate: true, hideProject: task.project) }
            }
            HStack(spacing: 8) {
                Image(systemName: "plus").foregroundStyle(.tertiary).frame(width: 16)
                TextField("Add sub-task", text: $newSubtask)
                    .textFieldStyle(.plain)
                    .onSubmit {
                        store.add(title: newSubtask, kind: .human, today: false, ready: false,
                                  project: task.project, parentId: task.id, open: false)
                        newSubtask = ""
                    }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder private var links: some View {
        if !task.links.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionHeader(title: "Links", count: task.links.count)
                ForEach(task.links, id: \.self) { link in
                    Button {
                        if let url = URL(string: link.url) { NSWorkspace.shared.open(url) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: link.url.hasPrefix("file:") ? "doc.text" : "link")
                            Text(link.title)
                            Text(link.url).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                }
            }
        }
    }

    private enum Entry: Identifiable {
        case comment(TaskComment), event(ActivityEvent)

        var id: String {
            switch self {
            case let .comment(c): "c\(c.id)"
            case let .event(e): "e\(e.id)"
            }
        }

        var time: String {
            switch self {
            case let .comment(c): c.createdAt
            case let .event(e): e.createdAt
            }
        }
    }

    /// Comments and activity, interleaved by time.
    private var timeline: some View {
        let entries = (store.comments.map(Entry.comment) + store.activity.map(Entry.event)).sorted { $0.time < $1.time }

        return VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Activity")
            if entries.isEmpty {
                Text("No activity yet.").font(.callout).foregroundStyle(.tertiary)
            }
            ForEach(entries) { entry in
                switch entry {
                case let .comment(c):
                    CommentBubble(comment: c)
                case let .event(e):
                    HStack(spacing: 8) {
                        Circle().fill(Color.secondary.opacity(0.4)).frame(width: 5, height: 5).frame(width: 22)
                        Text("\(e.actor ?? "system") \(describe(e))").foregroundStyle(.secondary)
                        RelativeTime(timestamp: e.createdAt).foregroundStyle(.tertiary)
                    }
                    .font(.caption)
                }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .trailing, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    if comment.isEmpty {
                        Text(task.kind == .agent && task.status == .in_progress
                             ? "Comment — goes straight to the running agent…" : "Leave a comment… (@agent hands it to an agent)")
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                    ComposerTextView(text: $comment, fontSize: 13) { images.append(contentsOf: $0) }
                        .frame(minHeight: 54, maxHeight: 180)
                }
                PendingImagesStrip(images: $images)
            }
            .padding(10)
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
            HStack {
                AttachImagesButton { images.append(contentsOf: $0) }
                Spacer()
                Button("Comment", action: sendComment)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty)
            }
        }
    }

    private func describe(_ e: ActivityEvent) -> String {
        switch e.kind {
        case "status":
            if let status = TaskStatus(rawValue: e.body) { return "set status to \(status.label)" }
            return e.body
        case "agent_log":
            return "· \(e.body)"
        default:
            return e.body
        }
    }

    private func saveTitle() {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t != task.title else { return }
        store.update(task, ["title": t]) { $0.title = t }
    }

    private func sendComment() {
        store.comment(on: task, comment, images: images)
        comment = ""
        images = []
    }
}

/// The agent's open question at the foot of the task, like the last comment in a thread: the full
/// message, its choices as buttons, and a roomy box to reply in.
struct ReplyCard: View {
    let task: BoardTask
    var store = BoardStore.shared
    @State private var picked: [Int: Set<String>] = [:]
    @State private var text = ""
    @State private var images: [PendingImage] = []

    private var questions: [AgentQuestion] { task.questionOptions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(.purple)
                Text("Agent").font(.callout.weight(.semibold))
                Text("is waiting on you").font(.callout).foregroundStyle(.secondary)
                Spacer()
                Button { store.dismissQuestion(task) } label: { Label("Not needed", systemImage: "xmark") }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .help("Nothing to answer: back to In progress and out of your inbox")
                if Cmux.isInstalled && task.sessionId != nil {
                    Button { Cmux.openSession(taskId: task.id) } label: { Label("Open session", systemImage: "terminal") }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
            }
            MarkdownView(text: task.question ?? "Waiting on you.", size: 14, selectable: true)

            ForEach(Array(questions.enumerated()), id: \.offset) { index, q in
                VStack(alignment: .leading, spacing: 8) {
                    if questions.count > 1 || q.header != nil {
                        Text(q.header ?? q.question).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    ForEach(q.options, id: \.self) { option in
                        choice(option, selected: picked[index, default: []].contains(option.label)) {
                            var set = picked[index, default: []]
                            if set.contains(option.label) { set.remove(option.label) }
                            else { if !q.multiSelect { set.removeAll() }; set.insert(option.label) }
                            picked[index] = set
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(questions.isEmpty ? "Reply to the agent… (paste or drop screenshots)" : "Add detail, or answer something else…")
                            .font(.system(size: 14))
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                    ComposerTextView(text: $text, fontSize: 14) { images.append(contentsOf: $0) }
                        .frame(minHeight: 90, maxHeight: 260)
                }
                PendingImagesStrip(images: $images)
            }
            .padding(10)
            .background(Color(nsColor: .textBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35)))

            HStack {
                AttachImagesButton { images.append(contentsOf: $0) }
                Text("⌘↩ sends · goes straight into the agent's session").font(.caption).foregroundStyle(.tertiary)
                Spacer()
                Button("Send reply", action: send)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(answer.isEmpty && images.isEmpty)
            }
        }
        .padding(16)
        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.orange.opacity(0.4)))
        .onChange(of: task.id) { _, _ in picked = [:]; text = ""; images = [] }
    }

    private func choice(_ option: AgentQuestion.Option, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).fontWeight(.medium)
                    if let description = option.description, !description.isEmpty {
                        Text(description).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.15)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Picked options (per question when there are several) plus anything typed.
    private var answer: String {
        var parts: [String] = []
        for (index, q) in questions.enumerated() {
            let chosen = q.options.map(\.label).filter { picked[index, default: []].contains($0) }
            guard !chosen.isEmpty else { continue }
            let joined = chosen.joined(separator: ", ")
            parts.append(questions.count > 1 ? "\(q.header ?? q.question): \(joined)" : joined)
        }
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { parts.append(typed) }
        return parts.joined(separator: "\n\n")
    }

    private func send() {
        let reply = answer
        guard !reply.isEmpty || !images.isEmpty else { return }
        store.answer(task, with: reply, images: images)
        picked = [:]
        text = ""
        images = []
    }
}

struct CommentBubble: View {
    let comment: TaskComment

    private var icon: String {
        switch comment.author {
        case "me": "person.crop.circle.fill"
        case "reviewer": "play.rectangle.fill"
        default: "sparkles"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(comment.author == "me" ? Color.accentColor : comment.author == "reviewer" ? .orange : .purple)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(comment.authorName).font(.callout.weight(.semibold))
                    if let time = comment.timecodeLabel {
                        Text(time).font(.caption.monospacedDigit()).foregroundStyle(Color.accentColor)
                    }
                    RelativeTime(timestamp: comment.createdAt).font(.caption).foregroundStyle(.tertiary)
                }
                HStack(alignment: .top, spacing: 10) {
                    if let still = comment.stillUrl.flatMap(URL.init(string:)) {
                        AsyncImage(url: still) { image in
                            image.resizable().scaledToFit()
                        } placeholder: {
                            Color.secondary.opacity(0.1)
                        }
                        .frame(width: 90, height: 90)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .onTapGesture { NSWorkspace.shared.open(still) }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if let quote = comment.quote {
                            Text("“\(quote)”")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                                .padding(.leading, 8)
                                .overlay(alignment: .leading) { Rectangle().fill(Color.yellow.opacity(0.7)).frame(width: 3) }
                        }
                        if !comment.body.isEmpty { MarkdownView(text: comment.body, size: 13, selectable: true) }
                    }
                }
                if let attachments = comment.attachments, !attachments.isEmpty {
                    CommentImages(attachments: attachments)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// The key properties as one wrapping row of menus, for the Inbox's detail pane.
struct CompactProperties: View {
    let task: BoardTask
    var store = BoardStore.shared

    var body: some View {
        FlowLayout(spacing: 6) {
            Menu {
                ForEach(TaskStatus.allCases, id: \.self) { s in Button(s.label) { store.setStatus(task, s) } }
            } label: { StatusPill(status: task.status) }
            .compactMenu()

            Menu {
                ForEach(TaskKind.allCases, id: \.self) { k in
                    Button { store.update(task, ["kind": k.rawValue]) { $0.kind = k } } label: { Label(k.label, systemImage: k.symbol) }
                }
            } label: { chip(task.kind.symbol, task.kind.label) }
            .compactMenu()

            Menu {
                ForEach(Priority.allCases, id: \.self) { p in Button(p.label) { store.update(task, ["priority": p.rawValue]) { $0.priority = p.rawValue } } }
            } label: { chip("chart.bar.fill", task.priorityLevel == .none ? "Priority" : task.priorityLevel.label) }
            .compactMenu()

            if let team = store.team(task.teamId) { chip(team.symbol, [team.name, task.project].compactMap { $0 }.joined(separator: " › ")) }
            if let day = task.scheduledOn { chip("calendar", Day.shortTitle(day)) }
            if let due = task.due { chip("flag", "Due \(Day.shortTitle(due))") }

            Button { store.section = .board; store.open(task.id) } label: { chip("arrow.up.left.and.arrow.down.right", "Open full page") }
                .buttonStyle(.plain)
        }
    }

    private func chip(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(text).lineLimit(1)
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Color.secondary.opacity(0.1), in: Capsule())
        .fixedSize()
    }
}

private extension View {
    func compactMenu() -> some View { menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize() }
}

/// Right-hand properties column.
struct TaskProperties: View {
    let task: BoardTask
    var store = BoardStore.shared
    @State private var newLabel = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            property("Status") {
                Picker("", selection: binding(\.status) { store.setStatus(task, $0) }) {
                    ForEach(TaskStatus.allCases, id: \.self) { Text($0.label).tag($0) }
                }
            }
            property("Assignee") {
                Picker("", selection: binding(\.kind) { v in store.update(task, ["kind": v.rawValue]) { $0.kind = v } }) {
                    ForEach(TaskKind.allCases, id: \.self) { Label($0.label, systemImage: $0.symbol).tag($0) }
                }
            }
            property("Priority") {
                Picker("", selection: binding(\.priority) { v in store.update(task, ["priority": v]) { $0.priority = v } }) {
                    ForEach(Priority.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
                }
            }
            property("Team") {
                Picker("", selection: binding(\.teamId) { store.setTeam(task, $0) }) {
                    Text("No team").tag(Int?.none)
                    ForEach(store.teams) { team in
                        Label(team.name, systemImage: team.symbol).tag(Int?.some(team.id))
                    }
                }
            }
            property("Project") { ProjectField(task: task) }
            if task.kind != .human { property("Repo") { RepoField(task: task) } }
            property("Labels") {
                VStack(alignment: .leading, spacing: 6) {
                    if !task.labels.isEmpty {
                        FlowRow(task.labels) { label in
                            LabelChip(label: label) { setLabels(task.labels.filter { $0 != label }) }
                        }
                    }
                    TextField("Add label", text: $newLabel)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            let l = newLabel.trimmingCharacters(in: .whitespaces)
                            if !l.isEmpty, !task.labels.contains(l) { setLabels(task.labels + [l]) }
                            newLabel = ""
                        }
                }
            }
            Divider()
            property("Scheduled") { DateField(value: task.scheduledOn) { store.schedule(task, on: $0) } }
            property("Due") {
                DateField(value: task.due) { day in store.update(task, ["due": day ?? NSNull()]) { $0.due = day } }
            }
            // The column hides control labels, so the checkbox carries its text alongside.
            HStack(spacing: 6) {
                Toggle("", isOn: binding(\.today) { v in store.update(task, ["today": v]) { $0.today = v } })
                    .toggleStyle(.checkbox)
                Text("Pin to Today").font(.callout)
            }
            Divider()
            if task.kind == .agent, let note = agentNote {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            if let worktree = task.worktree {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Worktree").font(.caption).foregroundStyle(.secondary)
                    Button {
                        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: worktree)
                    } label: {
                        Label((worktree as NSString).lastPathComponent, systemImage: "arrow.triangle.branch")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .help(worktree)
                }
            }
            if let source = task.source {
                Text("Created from \(source)").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .labelsHidden()
    }

    private var agentNote: String? {
        if task.status == .new { return "Set to Ready to let an agent pick this up." }
        if task.status == .ready, let day = task.scheduledOn, day > Day.today { return "Approved. Runs on \(Day.title(day))." }
        return nil
    }

    private func property<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }

    private func binding<V: Equatable>(_ keyPath: KeyPath<BoardTask, V>, set: @escaping (V) -> Void) -> Binding<V> {
        Binding(get: { task[keyPath: keyPath] }, set: { if $0 != task[keyPath: keyPath] { set($0) } })
    }

    private func setLabels(_ labels: [String]) {
        store.update(task, ["labels": labels]) { $0.labels = labels }
    }
}

/// Which repo an agent session starts in. Suggestions are the repos the runner found for the task's team.
struct RepoField: View {
    let task: BoardTask
    var store = BoardStore.shared
    @State private var text = ""

    private var suggestions: [LocalRepo] { store.localRepos.filter { $0.teamId == task.teamId && !$0.hidden } }

    var body: some View {
        HStack(spacing: 6) {
            TextField("Auto", text: $text)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
            Menu {
                Button("Auto (match from the task)") { text = ""; save() }
                Divider()
                ForEach(suggestions) { repo in
                    Button(repo.description.map { "\(repo.name) — \($0.prefix(50))" } ?? repo.name) { text = repo.name; save() }
                }
            } label: { Image(systemName: "chevron.down") }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
        }
        .help("The repo the agent's session starts in, with its own worktree. Auto picks the one repo the task names.")
        .onAppear { text = task.repo ?? "" }
        .onChange(of: task.id) { _, _ in text = task.repo ?? "" }
        .onChange(of: task.repo) { _, new in text = new ?? "" }
    }

    private func save() {
        let value = text.trimmingCharacters(in: .whitespaces)
        let repo: String? = value.isEmpty ? nil : value
        guard repo != task.repo else { return }
        store.update(task, ["repo": repo ?? NSNull()]) { $0.repo = repo }
    }
}

/// Optional date with a clear button; values are "YYYY-MM-DD".
struct DateField: View {
    let value: String?
    let onChange: (String?) -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let value {
                DatePicker("", selection: Binding(get: { Day.date(value) }, set: { onChange(Day.string($0)) }),
                           displayedComponents: .date)
                    .datePickerStyle(.field)
                    .fixedSize()
                Text(Day.title(value)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Button { onChange(nil) } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tertiary)
            } else {
                Menu("Set date") {
                    Button("Today") { onChange(Day.today) }
                    Button("Tomorrow") { onChange(Day.adding(1, to: Day.today)) }
                    Button("Next Monday") { onChange(Day.adding(7, to: Day.weekStart(Day.today))) }
                }
                .fixedSize()
            }
        }
    }
}

struct ProjectField: View {
    let task: BoardTask
    var store = BoardStore.shared
    @State private var text = ""

    var body: some View {
        HStack(spacing: 6) {
            if let project = task.project { Circle().fill(ProjectColor.of(project)).frame(width: 8, height: 8) }
            TextField("No project", text: $text)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
            Menu {
                ForEach(store.projects, id: \.self) { p in Button(p) { text = p; save() } }
                if task.project != nil { Divider(); Button("Clear") { text = ""; save() } }
            } label: { Image(systemName: "chevron.down") }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
        }
        .onAppear { text = task.project ?? "" }
        .onChange(of: task.id) { _, _ in text = task.project ?? "" }
    }

    private func save() {
        let value = text.trimmingCharacters(in: .whitespaces)
        let project: String? = value.isEmpty ? nil : value
        guard project != task.project else { return }
        store.update(task, ["project": project ?? NSNull()]) { $0.project = project }
    }
}

/// Wraps chips onto multiple lines.
struct FlowRow<Item: Hashable, Content: View>: View {
    let items: [Item]
    let content: (Item) -> Content

    init(_ items: [Item], @ViewBuilder content: @escaping (Item) -> Content) {
        self.items = items
        self.content = content
    }

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(items, id: \.self) { content($0) }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0,
                      height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (indices: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if !current.indices.isEmpty && current.width + spacing + size.width > width {
                rows.append(current)
                current = ([], 0, 0)
            }
            current.width += (current.indices.isEmpty ? 0 : spacing) + size.width
            current.height = max(current.height, size.height)
            current.indices.append(i)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
