import AppKit
import Foundation
import Observation

enum Section: Hashable {
    case inbox, today, upcoming, board
    case project(String)
    case team(Int)  // team settings
}

@MainActor
@Observable
final class BoardStore {
    static let shared = BoardStore()

    /// Every task loaded; views use `tasks`, which honours the team filter.
    // The Dock icon carries what needs you (unread, or an agent still waiting), so it shows even with the
    // window closed. Task statuses change it too: answering elsewhere takes a task out of Needs you.
    private(set) var allTasks: [BoardTask] = [] { didSet { updateDockBadge() } }
    private(set) var teams: [Team] = []
    private(set) var projectSpecs: [ProjectSpec] = []
    private(set) var localRepos: [LocalRepo] = []
    private(set) var webhooks: [Webhook] = []
    private(set) var inbox: [InboxItem] = [] { didSet { updateDockBadge() } }
    private(set) var lastError: String?
    private(set) var lastRefresh: Date?

    // Navigation
    var section: Section = .today
    /// nil shows every team.
    var teamFilter: Int? = UserDefaults.standard.object(forKey: "teamFilter") as? Int {
        didSet { UserDefaults.standard.set(teamFilter, forKey: "teamFilter") }
    }
    /// Board search and filters. Kept here so they survive opening a task and coming back.
    var boardFilter = BoardFilter()
    var boardSort = BoardSort(rawValue: UserDefaults.standard.string(forKey: "boardSort") ?? "") ?? .priority {
        didSet { UserDefaults.standard.set(boardSort.rawValue, forKey: "boardSort") }
    }
    /// The open New task composer, if any.
    var composer: TaskDraft?
    var selectedTaskId: Int? { didSet { if selectedTaskId != oldValue { Task { await loadDetail() } } } }
    var day: String = Day.today
    var weekStart: String = Day.weekStart(Day.today)

    // Selected task detail
    private(set) var comments: [TaskComment] = []
    private(set) var activity: [ActivityEvent] = []

    private var api: BoardAPI?
    private var timer: Timer?
    private var notifiedInbox: Set<Int>?  // nil until first load so launch doesn't notify

    // MARK: Derived

    var tasks: [BoardTask] {
        guard let teamFilter else { return allTasks }
        return allTasks.filter { $0.teamId == teamFilter }
    }

    func task(_ id: Int) -> BoardTask? { allTasks.first { $0.id == id } }
    func team(_ id: Int?) -> Team? { id.flatMap { id in teams.first { $0.id == id } } }
    var currentTeam: Team? { team(teamFilter) }
    func spec(for project: String) -> ProjectSpec? {
        projectSpecs.first { $0.name.caseInsensitiveCompare(project) == .orderedSame }
    }

    var selectedTask: BoardTask? { selectedTaskId.flatMap(task) }
    /// Unread inbox rows (tasks with something new), as the sidebar and menu bar count them.
    var unreadCount: Int { inboxThreads.filter(\.isUnread).count }
    /// What the badges show: unread threads plus agents still waiting on you after you've read them.
    var attentionCount: Int { inboxThreads.filter(\.needsAttention).count }

    private func updateDockBadge() {
        NSApp?.dockTile.badgeLabel = attentionCount > 0 ? "\(attentionCount)" : nil
    }
    /// Questions from any team: they block agents, so they show whichever team is in view.
    var needsYou: [BoardTask] { allTasks.filter { $0.status == .needs_you } }
    // Not the ones that have published and are waiting for a decision: nothing is running there.
    var running: [BoardTask] { tasks.filter { $0.status == .in_progress && $0.kind == .agent && !$0.isAwaitingReview } }
    /// Projects in the current team: ones with tasks plus ones set up in team settings.
    var projects: [String] {
        let specs = projectSpecs.filter { teamFilter == nil || $0.teamId == teamFilter }.map(\.name)
        return Array(Set(tasks.compactMap(\.project) + specs)).sorted()
    }
    var allLabels: [String] { Array(Set(tasks.flatMap(\.labels))).sorted() }

    func sorted(_ list: [BoardTask]) -> [BoardTask] {
        list.sorted { ($0.priorityLevel.rank, $0.sortOrder, $0.id) < ($1.priorityLevel.rank, $1.sortOrder, $1.id) }
    }

    func tasks(on day: String) -> [BoardTask] {
        sorted(tasks.filter { $0.isOn(day: day) && $0.status != .needs_you })
    }

    func done(on day: String) -> [BoardTask] { tasks.filter { $0.completedDay == day } }

    /// Things on the owner's plate today: their tasks plus anything waiting on them.
    var onYourPlate: [BoardTask] { tasks(on: Day.today).filter { $0.kind != .agent } }

    var unscheduled: [BoardTask] {
        sorted(tasks.filter { $0.status.isOpen && $0.calendarDay == nil && !$0.today })
    }

    func column(_ status: TaskStatus, project: String? = nil) -> [BoardTask] {
        let list = status == .done
            ? tasks.filter { $0.status == .done }.sorted { ($0.completedAt ?? "") > ($1.completedAt ?? "") }
            : sorted(tasks.filter { $0.status == status })
        let sortedList = boardSort.sort(list) ?? list
        let filtered = boardFilter.isActive ? sortedList.filter(boardFilter.matches) : sortedList
        return project.map { p in filtered.filter { $0.project == p } } ?? filtered
    }

    func subtasks(of id: Int) -> [BoardTask] { allTasks.filter { $0.parentId == id } }

    // MARK: Sync

    func start() {
        // CC_SECTION=inbox|upcoming|board|team:<id> and CC_SELECT=<id> / CC_COMPOSE=1 open a specific view (handy for screenshots).
        let env = ProcessInfo.processInfo.environment
        switch env["CC_SECTION"] {
        case "inbox": section = .inbox
        case "upcoming": section = .upcoming
        case "board": section = .board
        case let value? where value.hasPrefix("team:"):
            if let id = Int(value.dropFirst(5)) { teamFilter = id; section = .team(id) }
        default: break
        }
        if let id = env["CC_SELECT"].flatMap(Int.init) { selectedTaskId = id }
        if let query = env["CC_SEARCH"] { boardFilter.query = query }
        if env["CC_COMPOSE"] != nil { composer = defaults(TaskDraft(kind: .agent, scheduledOn: Day.adding(3, to: Day.today))) }
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
            Task { @MainActor in
                BoardStore.shared.followToday()
                await BoardStore.shared.refresh()
            }
        }
        // The timer doesn't fire while the Mac sleeps, so catch midnight and waking up straight away too.
        for name in [Notification.Name.NSCalendarDayChanged, NSWorkspace.didWakeNotification] {
            let center = name == NSWorkspace.didWakeNotification ? NSWorkspace.shared.notificationCenter : NotificationCenter.default
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in BoardStore.shared.followToday() }
            }
        }
    }

    /// The day `day` and `weekStart` were last kept in step with.
    @ObservationIgnored private var knownToday = Day.today

    /// The app stays open for days: when the date changes, Today and Upcoming move with it, unless
    /// you'd browsed to another day or week, which stays put.
    func followToday() {
        let now = Day.today
        guard now != knownToday else { return }
        if day == knownToday { day = now }
        if weekStart == Day.weekStart(knownToday) { weekStart = Day.weekStart(now) }
        knownToday = now
    }

    private func client() throws -> BoardAPI {
        if let api { return api }
        let made = try BoardAPI()
        api = made
        return made
    }

    func refresh() async {
        do {
            let api = try client()
            async let t = api.fetchTasks()
            async let i = api.fetchInbox()
            async let tm = api.fetchTeams()
            async let p = api.fetchProjects()
            async let r = api.fetchRepos()
            let (fresh, all, freshTeams, specs, repos) = try await (t, i, tm, p, r)
            // FYI notes drowned out what needs you: leave them out of the inbox, its counts and notifications.
            let items = all.filter(\.needsYou)
            localRepos = repos
            notifyNew(items)
            allTasks = fresh
            inbox = items
            teams = freshTeams
            projectSpecs = specs
            if let teamFilter, !freshTeams.contains(where: { $0.id == teamFilter }) { self.teamFilter = nil }
            lastError = nil
            lastRefresh = Date()
            if selectedTaskId != nil { await loadDetail() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadDetail() async {
        guard let id = selectedTaskId, let api = try? client() else {
            comments = []
            activity = []
            return
        }
        async let c = api.fetchComments(id)
        async let a = api.fetchActivity(id)
        comments = (try? await c) ?? []
        activity = (try? await a) ?? []
    }

    private func notifyNew(_ items: [InboxItem]) {
        let unread = items.filter(\.isUnread)
        if let seen = notifiedInbox {
            for item in unread where !seen.contains(item.id) {
                Notifier.send(id: "n-\(item.id)", title: "\(item.headline) · CC-\(item.task.id)",
                              body: item.kind == "comment" || item.kind == "question" ? item.body : item.task.title)
            }
        }
        notifiedInbox = Set(unread.map(\.id))
    }

    /// Apply locally for instant UI, write through, then resync.
    private func mutate(_ id: Int, local: (inout BoardTask) -> Void, remote: @escaping (BoardAPI) async throws -> Void) {
        if let i = allTasks.firstIndex(where: { $0.id == id }) { local(&allTasks[i]) }
        Task {
            do {
                try await remote(try client())
            } catch {
                lastError = error.localizedDescription
            }
            await refresh()
        }
    }

    // MARK: Actions

    func open(_ id: Int) {
        selectedTaskId = id
        markRead(taskId: id)
    }

    /// Opens the composer, filling in whatever the current view implies.
    func compose(_ base: TaskDraft = TaskDraft()) {
        composer = defaults(base)
        BoardWindow.show()
    }

    func defaults(_ base: TaskDraft = TaskDraft()) -> TaskDraft {
        var draft = base
        if let open = selectedTask, draft.project == nil, draft.teamId == nil {  // on a task page: same team and project
            draft.project = open.project
            draft.teamId = open.teamId
        }
        if draft.project == nil, case let .project(name) = section, selectedTaskId == nil { draft.project = name }
        if draft.teamId == nil { draft.teamId = draft.project.flatMap(spec(for:))?.teamId ?? teamFilter }
        return draft
    }

    func create(_ fields: [String: Any], files: [PendingFile] = [], open: Bool) {
        Task {
            do {
                let api = try client()
                // Files go up before the row exists, so a ready agent task is never picked up without them.
                var fields = fields
                if !files.isEmpty { fields["attachments"] = try await Self.upload(files, to: "new", with: api).map(\.json) }
                let task = try await api.addTask(fields)
                await refresh()
                if open { selectedTaskId = task.id }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func add(title: String, kind: TaskKind, today: Bool, ready: Bool, scheduledOn: String? = nil, project: String? = nil,
             parentId: Int? = nil, open: Bool = true) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        var fields: [String: Any] = ["title": title, "kind": kind.rawValue, "today": today,
                                     "status": ready ? "ready" : "new", "source": "app"]
        if let scheduledOn { fields["scheduled_on"] = scheduledOn }
        if let project, !project.isEmpty { fields["project"] = project }
        // New tasks land in the team being viewed; a project that already has a team wins.
        if let teamId = parentId.flatMap(task)?.teamId ?? teamFilter { fields["team_id"] = teamId }
        if let parentId { fields["parent_id"] = parentId }
        Task {
            do {
                let task = try await client().addTask(fields)
                await refresh()
                if open { selectedTaskId = task.id }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// Generic field update. Keys are database column names.
    func update(_ task: BoardTask, _ fields: [String: Any], local: @escaping (inout BoardTask) -> Void) {
        mutate(task.id, local: local) { api in try await api.update(task.id, fields) }
    }

    func setStatus(_ task: BoardTask, _ status: TaskStatus) {
        guard task.status != status else { return }
        var fields: [String: Any] = ["status": status.rawValue]
        if status != .needs_you { fields["question"] = NSNull() }
        mutate(task.id, local: { $0.status = status; if status == .done { $0.completedAt = ISO8601DateFormatter().string(from: Date()) } }) { api in
            try await api.update(task.id, fields)
            try await api.addEvent(task.id, kind: "status", body: status.rawValue)
        }
    }

    func complete(_ task: BoardTask) { setStatus(task, .done) }

    func schedule(_ task: BoardTask, on day: String?) {
        update(task, ["scheduled_on": day ?? NSNull()]) { $0.scheduledOn = day }
    }

    func answer(_ task: BoardTask, with text: String, images: [PendingFile] = []) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !images.isEmpty else { return }
        // Keep the question in the history: questions caught from a session aren't comments yet.
        let question = task.question?.trimmingCharacters(in: .whitespacesAndNewlines)
        let alreadyPosted = selectedTaskId == task.id && comments.contains { $0.author == "agent" && $0.body == question }
        mutate(task.id, local: { $0.status = .ready; $0.question = nil; $0.questionOptions = nil }) { api in
            if let question, !question.isEmpty, !alreadyPosted {
                try await api.addComment(task.id, body: question, author: "agent")
            }
            try await api.addComment(task.id, body: text, attachments: try await Self.upload(images, to: String(task.id), with: api))
            try await api.update(task.id, ["status": "ready", "question": NSNull()], onlyIfStatus: .needs_you)
        }
    }

    /// The agent didn't really need anything: back to in progress, out of the inbox.
    func dismissQuestion(_ task: BoardTask) {
        mutate(task.id, local: { $0.status = .in_progress; $0.question = nil; $0.questionOptions = nil }) { api in
            try await api.update(task.id, ["status": "in_progress", "question": NSNull()], onlyIfStatus: .needs_you)
        }
    }

    /// Files go up before the task or comment row, so the runner never sees one whose files aren't there yet.
    private static func upload(_ files: [PendingFile], to folder: String, with api: BoardAPI) async throws -> [FileAttachment] {
        var stored: [FileAttachment] = []
        for file in files { stored.append(try await api.uploadFile(file, folder: folder)) }
        return stored
    }

    /// Shows a problem in the usual error banner (e.g. a file too big to attach).
    func report(_ message: String) { lastError = message }

    @ObservationIgnored private var imageCache: [String: NSImage] = [:]

    /// A comment's image, fetched with the service key (the bucket is private) and kept for the session.
    func image(at path: String) async -> NSImage? {
        if let cached = imageCache[path] { return cached }
        guard let data = try? await client().downloadFile(path), let image = NSImage(data: data) else { return nil }
        imageCache[path] = image
        return image
    }

    /// In its default app (Preview for images), from a temporary copy under its own name.
    func openFile(_ attachment: FileAttachment) {
        Task {
            do {
                let data = try await client().downloadFile(attachment.path)
                let dir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("cc-\(attachment.path.replacingOccurrences(of: "/", with: "-"))")
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let url = dir.appendingPathComponent(attachment.name.replacingOccurrences(of: "/", with: "-"))
                try data.write(to: url)
                NSWorkspace.shared.open(url)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func comment(on task: BoardTask, _ text: String, images: [PendingFile] = []) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !images.isEmpty else { return }
        Task {
            do {
                let api = try client()
                try await api.addComment(task.id, body: text, attachments: try await Self.upload(images, to: String(task.id), with: api))
            } catch {
                lastError = error.localizedDescription
            }
            await loadDetail()
        }
    }

    // MARK: Teams and projects

    func addTeam(name: String, kind: String = "company") {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            do {
                let team = try await client().addTeam(["name": name, "key": Team.slug(name), "kind": kind,
                                                       "sort_order": (teams.map(\.sortOrder).max() ?? 0) + 1])
                await refresh()
                teamFilter = team.id
                section = .team(team.id)
                selectedTaskId = nil
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func updateTeam(_ team: Team, _ fields: [String: Any], local: @escaping (inout Team) -> Void) {
        if let i = teams.firstIndex(where: { $0.id == team.id }) { local(&teams[i]) }
        Task {
            do { try await client().updateTeam(team.id, fields) } catch { lastError = error.localizedDescription }
            await refresh()
        }
    }

    func updateProject(_ spec: ProjectSpec, _ fields: [String: Any], local: @escaping (inout ProjectSpec) -> Void) {
        if let i = projectSpecs.firstIndex(where: { $0.id == spec.id }) { local(&projectSpecs[i]) }
        Task {
            do { try await client().updateProject(spec.id, fields) } catch { lastError = error.localizedDescription }
            await refresh()
        }
    }

    // MARK: Webhooks

    /// Only the team settings page shows these, so it loads them itself rather than every board refresh.
    func loadWebhooks(team: Int) async {
        do {
            webhooks = try await client().fetchWebhooks(team: team)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// The secret on success. It's only ever available here, so the caller has to show it.
    func addWebhook(team: Int, url: String, project: Int?, events: [String], scope: String) async throws -> String {
        let secret = try await client().createWebhook(team: team, url: url, project: project, events: events, scope: scope)
        await loadWebhooks(team: team)
        return secret
    }

    private func changeWebhook(_ hook: Webhook, _ change: @escaping (BoardAPI) async throws -> Void) {
        Task {
            do { try await change(client()) } catch { lastError = error.localizedDescription }
            await loadWebhooks(team: hook.teamId)
        }
    }

    func setWebhookActive(_ hook: Webhook, _ active: Bool) { changeWebhook(hook) { try await $0.setWebhookActive(hook.id, active) } }
    func testWebhook(_ hook: Webhook) { changeWebhook(hook) { try await $0.testWebhook(hook.id) } }
    func deleteWebhook(_ hook: Webhook) { changeWebhook(hook) { try await $0.deleteWebhook(hook.id) } }

    func addProject(_ name: String, teamId: Int) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            do {
                if let existing = spec(for: name) {
                    try await client().updateProject(existing.id, ["team_id": teamId])
                } else {
                    try await client().addProject(["name": name, "team_id": teamId])
                }
            } catch {
                lastError = error.localizedDescription
            }
            await refresh()
        }
    }

    func setBaseBranch(_ repo: LocalRepo, _ branch: String?) {
        if let i = localRepos.firstIndex(where: { $0.id == repo.id }) { localRepos[i].baseBranch = branch }
        Task {
            do { try await client().updateRepo(repo.id, ["base_branch": branch ?? NSNull()]) } catch { lastError = error.localizedDescription }
        }
    }

    func setHidden(_ repo: LocalRepo, _ hidden: Bool) {
        if let i = localRepos.firstIndex(where: { $0.id == repo.id }) { localRepos[i].hidden = hidden }
        Task {
            do { try await client().updateRepo(repo.id, ["hidden": hidden]) } catch { lastError = error.localizedDescription }
        }
    }

    func setAliases(_ repo: LocalRepo, _ aliases: [String]) {
        if let i = localRepos.firstIndex(where: { $0.id == repo.id }) { localRepos[i].aliases = aliases }
        Task {
            do { try await client().updateRepo(repo.id, ["aliases": aliases]) } catch { lastError = error.localizedDescription }
        }
    }

    func setTeam(_ task: BoardTask, _ teamId: Int?) {
        update(task, ["team_id": teamId ?? NSNull()]) { $0.teamId = teamId }
    }

    func markRead(taskId: Int) {
        let ids = inbox.filter { $0.isUnread && $0.task.id == taskId }.map(\.id)
        markRead(ids: ids)
    }

    func markRead(ids: [Int]) {
        guard !ids.isEmpty else { return }
        let now = ISO8601DateFormatter().string(from: Date())
        inbox = inbox.map { item in
            ids.contains(item.id) && item.isUnread
                ? InboxItem(id: item.id, kind: item.kind, body: item.body, author: item.author, readAt: now, createdAt: item.createdAt, task: item.task)
                : item
        }
        Task {
            do { try await client().markRead(ids: ids) } catch { lastError = error.localizedDescription }
        }
    }

    /// Inbox items grouped one row per task, newest activity first (Linear-style).
    /// Agents waiting on you first (they're blocked), then newest first. A question that's been read is
    /// still unanswered, so waiting comes from the task's live status, not the notification's read state.
    var inboxThreads: [InboxThread] {
        // A stopped session isn't asking you anything: it stays on the board in Needs you, not in the inbox.
        let needsYou = needsYou.filter { !$0.isStopped }
        let waiting = Set(needsYou.map(\.id))
        var threads = Dictionary(grouping: inbox, by: \.task.id)
            .map { InboxThread(items: $0.value.sorted { $0.createdAt > $1.createdAt }, waiting: waiting.contains($0.key)) }
        // A waiting task with no notification loaded (older than the inbox's window, or made straight into
        // Needs you) still belongs here, so the inbox and the "waiting on you" banner always agree.
        let shown = Set(threads.map(\.id))
        for task in needsYou where !shown.contains(task.id) {
            let standIn = InboxItem(id: -task.id, kind: "question", body: task.question ?? "Waiting on you.",
                                     readAt: task.updatedAt ?? "", createdAt: task.updatedAt ?? "",
                                     task: .init(id: task.id, title: task.title, status: task.status))
            threads.append(InboxThread(items: [standIn], waiting: true))
        }
        return threads.sorted { ($0.waiting ? 1 : 0, $0.latest.createdAt) > ($1.waiting ? 1 : 0, $1.latest.createdAt) }
    }

    /// Archive = read: it leaves the Unread view.
    func archive(_ thread: InboxThread) { markRead(ids: thread.items.filter(\.isUnread).map(\.id)) }

    func markUnread(_ thread: InboxThread) {
        let id = thread.latest.id
        inbox = inbox.map { item in
            item.id == id ? InboxItem(id: item.id, kind: item.kind, body: item.body, author: item.author, readAt: nil, createdAt: item.createdAt, task: item.task) : item
        }
        Task {
            do { try await client().markUnread(ids: [id]) } catch { lastError = error.localizedDescription }
        }
    }

    func markAllRead() { markRead(ids: inbox.filter(\.isUnread).map(\.id)) }
}
