import SwiftUI

/// Renders the Markdown that tasks and comments are written in: headings, lists and checklists,
/// code blocks, quotes, rules and inline styles. Bare URLs and CC-123 references become links.
/// Single newlines are kept as line breaks, the way Linear and Slack treat them.
struct MarkdownView: View {
    let text: String
    var size: CGFloat = 14
    var selectable = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                render(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(Selectable(enabled: selectable))
    }

    private struct Selectable: ViewModifier {
        let enabled: Bool
        func body(content: Content) -> some View {
            if enabled { content.textSelection(.enabled) } else { content }
        }
    }

    @ViewBuilder private func render(_ block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            Text(Self.inline(text))
                .font(.system(size: size + CGFloat(max(0, 4 - level) * 3), weight: .semibold))
                .padding(.top, level == 1 ? 6 : 3)
        case let .paragraph(text):
            Text(Self.inline(text)).font(.system(size: size)).lineSpacing(2)
        case let .list(items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        marker(item.marker)
                        Text(Self.inline(item.text)).font(.system(size: size)).lineSpacing(2)
                            .strikethrough(item.marker == .checked, color: .secondary)
                            .foregroundStyle(item.marker == .checked ? .secondary : .primary)
                    }
                    .padding(.leading, CGFloat(item.depth) * 18 + 2)
                }
            }
        case let .code(code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: size - 1, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
        case let .quote(text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1).fill(Color.secondary.opacity(0.4)).frame(width: 3)
                Text(Self.inline(text)).font(.system(size: size)).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    @ViewBuilder private func marker(_ marker: MarkdownBlock.Marker) -> some View {
        switch marker {
        case .bullet:
            Text("•").font(.system(size: size, weight: .bold)).foregroundStyle(.secondary)
        case let .number(n):
            Text("\(n).").font(.system(size: size).monospacedDigit()).foregroundStyle(.secondary)
        case .unchecked:
            Image(systemName: "square").font(.system(size: size - 1)).foregroundStyle(.secondary)
        case .checked:
            Image(systemName: "checkmark.square.fill").font(.system(size: size - 1)).foregroundStyle(Color.accentColor)
        }
    }

    // MARK: Inline

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    private static let taskRef = try! NSRegularExpression(pattern: #"\bCC-(\d+)\b"#)

    static func inline(_ source: String) -> AttributedString {
        var text = (try? AttributedString(markdown: source, options: .init(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        ))) ?? AttributedString(source)

        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
            text[run.range].font = .system(.callout, design: .monospaced)
            text[run.range].backgroundColor = Color.secondary.opacity(0.18)
        }

        // Link bare URLs and task references that the Markdown didn't already link.
        let plain = String(text.characters)
        let whole = NSRange(plain.startIndex..., in: plain)
        var found: [(NSRange, URL)] = (detector?.matches(in: plain, range: whole) ?? []).compactMap { m in
            m.url.map { (m.range, $0) }
        }
        found += taskRef.matches(in: plain, range: whole).compactMap { m in
            guard let r = Range(m.range(at: 1), in: plain) else { return nil }
            return URL(string: "controlcenter://task/\(plain[r])").map { (m.range, $0) }
        }
        for (nsRange, url) in found {
            guard let r = Range(nsRange, in: plain) else { continue }
            let start = text.index(text.startIndex, offsetByCharacters: plain.distance(from: plain.startIndex, to: r.lowerBound))
            let range = start..<text.index(start, offsetByCharacters: plain.distance(from: r.lowerBound, to: r.upperBound))
            let slice = text[range]
            let isLinked = slice.runs.contains { $0.link != nil }
            let isCode = slice.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true }
            if !isLinked && !isCode { text[range].link = url }
        }

        for run in text.runs where run.link != nil {
            text[run.range].foregroundColor = .accentColor
        }
        return text
    }
}

enum MarkdownBlock {
    enum Marker: Equatable {
        case bullet, number(Int), unchecked, checked
    }

    struct Item {
        var depth: Int
        var marker: Marker
        var text: String
    }

    case heading(Int, String)
    case paragraph(String)
    case list([Item])
    case code(String)
    case quote(String)
    case rule

    private static let listItem = try! NSRegularExpression(pattern: #"^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$"#)
    private static let heading = try! NSRegularExpression(pattern: #"^(#{1,6})\s+(.*?)\s*#*\s*$"#)

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var items: [Item] = []
        var quote: [String] = []
        var code: [String]?

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !items.isEmpty { blocks.append(.list(items)); items = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }

        for line in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if var open = code {
                if trimmed.hasPrefix("```") {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    open.append(line)
                    code = open
                }
                continue
            }
            if trimmed.hasPrefix("```") { flush(); code = []; continue }
            if trimmed.isEmpty { flush(); continue }

            let ns = NSRange(line.startIndex..., in: line)
            if let m = heading.firstMatch(in: line, range: ns) {
                flush()
                blocks.append(.heading(m.range(at: 1).length, capture(line, m, 2)))
            } else if ["---", "***", "___"].contains(trimmed.replacingOccurrences(of: " ", with: "")) && paragraph.isEmpty {
                flush()
                blocks.append(.rule)
            } else if trimmed.hasPrefix(">") {
                if !paragraph.isEmpty || !items.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else if let m = listItem.firstMatch(in: line, range: ns) {
                if !paragraph.isEmpty || !quote.isEmpty { flush() }
                let indent = capture(line, m, 1).replacingOccurrences(of: "\t", with: "  ").count
                let bullet = capture(line, m, 2)
                let box = capture(line, m, 3)
                let marker: Marker = m.range(at: 3).location != NSNotFound
                    ? (box == " " ? .unchecked : .checked)
                    : Int(bullet.dropLast()).map(Marker.number) ?? .bullet
                items.append(Item(depth: min(indent / 2, 4), marker: marker, text: capture(line, m, 4)))
            } else if !items.isEmpty && line.first?.isWhitespace == true {
                items[items.count - 1].text += "\n" + trimmed  // continuation of a list item
            } else {
                if !items.isEmpty || !quote.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        if let open = code { blocks.append(.code(open.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func capture(_ line: String, _ match: NSTextCheckingResult, _ group: Int) -> String {
        Range(match.range(at: group), in: line).map { String(line[$0]) } ?? ""
    }
}
