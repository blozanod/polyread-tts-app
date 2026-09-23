"""A small typesetter for extraction test documents.

Produces PDFs whose correct reading is known exactly, in the layouts academic
readings actually come in:

  chapter.pdf   single column, first-line indents, no paragraph spacing,
                running heads, folios, block quotes, footnotes, italics,
                small caps, hyphenation at line ends and across pages
  article.pdf   full-width title and abstract over two justified columns,
                column footnotes, paragraphs running across columns and pages
  scan.pdf      the chapter as a scan's OCR layer: one invisible text object per
                word, a 0.35 degree skew, per-word baseline jitter and font size,
                a database cover page and a per-page download stamp
  bold.pdf      the chapter with its headings drawn twice (fake bold), which
                pdf.js reports as every heading word twice

Each writes <name>.expected.json: the spoken blocks in reading order, and the
footnote bodies. tests/layouts.test.ts holds the extractor to them.

    python3 -m pip install reportlab
    python3 scripts/make-layout-fixtures.py

The output is deterministic, so re-running it only changes the fixtures when
this script changes.
"""
import json
import math
import random
import re
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "layouts"
OUT.mkdir(exist_ok=True)

# The standard Times faces, which a PDF names rather than embeds: the fixtures
# stay a few kilobytes, and pdf.js carries the metrics itself.
FONTS = {"Serif": "Times-Roman", "Serif-Italic": "Times-Italic", "Serif-Bold": "Times-Bold"}

SENTENCES = [
    "The comparative study of democratic consolidation has long been divided between scholars who emphasize structural conditions and those who emphasize the strategic choices of political elites.",
    "Economic development, in this view, produces an educated middle class whose members demand representation and resist arbitrary rule.",
    "Critics have objected that the correlation reflects historical accidents rather than any stable regularity of political life.",
    "As Przeworski and his collaborators observed, “democracies can be born for any number of reasons, but they survive in wealthy societies.”",
    "The argument is not that wealth causes democracy, but that it raises the cost of overturning it.",
    "Consider the case of a coalition government that depends on the support of a small regional party.",
    "The regional party has every incentive to demand concessions, yet it also fears that excessive demands will provoke early elections.",
    "Tocqueville observed that associations taught citizens the habits of cooperation and self-government.",
    "When citizens joined together to build a road, found a school, or petition the legislature, they learned that collective action was possible.",
    "Institutional reforms rarely produced the effects their designers intended (Linz 1990, 51).",
    "Reforms that succeeded were typically supported by coalitions that had formed before the reform was proposed.",
    "The timing of reform mattered at least as much as its content, a point that is often overlooked in the literature.",
    "Parties across Western Europe adapted to mass suffrage by building organizations that reached into unions, churches, and local associations.",
    "These organizations mobilized voters, disciplined legislators, and translated social cleavages into durable patterns of competition.",
    "Why do some states build effective bureaucracies while others remain captured by patronage networks?",
    "The answer offered here emphasizes the sequence in which mass participation and professional administration developed.",
    "Where a professional civil service was established before the expansion of the franchise, politicians found it difficult to distribute public jobs.",
    "Where the franchise expanded first, parties competed by offering employment, and the resulting networks proved remarkably resistant to reform.",
    "Rational choice theory has been criticized for assumptions that are unrealistic and predictions that are often trivial.",
    "Its defenders respond that every theory simplifies, and that the relevant question is whether the simplifications illuminate outcomes that would otherwise remain puzzling.",
    "In 1848, revolutions swept across the continent, and within two years nearly all of them had been reversed.",
    "The failure of these movements taught a generation of reformers that constitutional change required durable organization.",
    "Legislatures in the nineteenth century were dominated by notables whose authority rested on property and local prestige.",
    "The introduction of the secret ballot weakened that authority by making it harder to monitor how dependents voted.",
    "Scholars disagree about whether the ballot reform was a cause or a consequence of declining clientelism.",
    "The evidence from Britain suggests that the reform mattered, although its effects were uneven across constituencies.",
    "What remains unclear is why some electorates responded to the new rules so much faster than others.",
    "One answer points to literacy, another to the density of civic associations, and a third to the structure of landholding.",
]

# MARK: content


class Piece:
    """A run of one font inside a word."""

    def __init__(self, text, font="Serif", scale=1.0, rise=0.0):
        self.text, self.font, self.scale, self.rise = text, font, scale, rise


class Word:
    def __init__(self, pieces, note=None):
        self.pieces = pieces  # list[Piece]
        self.note = note  # footnote number following this word

    @property
    def text(self):
        return "".join(p.text for p in self.pieces)


def words_of(text, rng, *, style="Serif"):
    out = []
    for w in text.split(" "):
        r = rng.random()
        if style == "Serif" and r < 0.035 and w.isalpha():
            out.append(Word([Piece(w, "Serif-Italic")]))
        elif style == "Serif" and r < 0.05 and w[:1].isupper() and w.isalpha() and len(w) > 3:
            # small caps: a full-size capital, then reduced capitals — two
            # font runs and no space between them
            out.append(Word([Piece(w[0]), Piece(w[1:].upper(), scale=0.78)]))
        elif style == "Serif" and r < 0.06 and w.endswith(".") and len(w) > 4 and w[:-1].isalpha():
            # a word whose trailing period is set in another font
            out.append(Word([Piece(w[:-1], "Serif-Italic"), Piece(".")]))
        else:
            out.append(Word([Piece(w, style)]))
    return out


def paragraph(rng, n):
    return " ".join(rng.choice(SENTENCES) for _ in range(n))


def build_content(seed, *, article):
    rng = random.Random(seed)
    blocks = []  # dicts: kind, words, plain
    notes = []
    if article:
        title = "Sequencing and the State: Bureaucratic Autonomy in Comparative Perspective"
        blocks.append(dict(kind="title", plain=title))
        blocks.append(dict(kind="center", plain="Ana Ruiz, University of Somewhere"))
        blocks.append(dict(kind="abstract", plain=paragraph(rng, 4)))
    else:
        blocks.append(dict(kind="h1", plain="3. The Politics of Reform"))
    sections = ["Origins of the Argument", "Evidence from Britain", "Alternative Explanations", "Conclusion"]
    for s_index, section in enumerate(sections):
        if s_index > 0 or article:
            blocks.append(dict(kind="h2", plain=section))
        for p_index in range(rng.randint(4, 6)):
            blocks.append(dict(kind="body", first=p_index == 0, plain=paragraph(rng, rng.randint(2, 7))))
            if rng.random() < 0.2:
                blocks.append(dict(kind="quote", plain=paragraph(rng, rng.randint(2, 3))))
    for block in blocks:
        style = {"title": "Serif-Bold", "h1": "Serif-Bold", "h2": "Serif-Bold"}.get(block["kind"], "Serif")
        block["words"] = words_of(block["plain"], rng, style=style)
        if block["kind"] == "body" and rng.random() < 0.4:
            # a footnote marker after the first sentence-final word
            for i, word in enumerate(block["words"][:-1]):
                if word.text.endswith("."):
                    notes.append(paragraph(rng, rng.randint(1, 2)))
                    word.note = len(notes)
                    block.setdefault("notes", []).append(len(notes))
                    break
    return blocks, notes


# MARK: layout

SIZES = {"title": 17, "center": 11, "abstract": 9.5, "h1": 15, "h2": 12, "body": 11, "quote": 10, "note": 8.5}
LEADING = 1.22


def width_of(word, size):
    return sum(pdfmetrics.stringWidth(p.text, FONTS[p.font], size * p.scale) for p in word.pieces)


def hyphen_points(text):
    """Allowed cuts inside a long alphabetic word."""
    core = re.match(r"^[A-Za-z]+", text)
    if not core or len(core.group(0)) < 9:
        return []
    n = len(core.group(0))
    return [k for k in range(4, n - 3)]


def split_word(word, at):
    """`word` cut after `at` characters: (left + hyphen, right)."""
    left, right, count = [], [], 0
    for p in word.pieces:
        if count + len(p.text) <= at:
            left.append(p)
        elif count >= at:
            right.append(p)
        else:
            k = at - count
            left.append(Piece(p.text[:k], p.font, p.scale, p.rise))
            right.append(Piece(p.text[k:], p.font, p.scale, p.rise))
        count += len(p.text)
    last = left[-1]
    left[-1] = Piece(last.text + "-", last.font, last.scale, last.rise)
    return Word(left), Word(right, word.note)


def break_lines(words, size, width, indent):
    """Greedy justified lines; returns list of (words, is_last, indent)."""
    lines, current, line_width = [], [], 0
    space = pdfmetrics.stringWidth(" ", FONTS["Serif"], size)
    queue = list(words)
    first = True
    while queue:
        word = queue.pop(0)
        avail = width - (indent if first else 0)
        w = width_of(word, size)
        extra = (space if current else 0) + w
        if line_width + extra <= avail or not current:
            current.append(word)
            line_width += extra
            continue
        # try hyphenating the word into the remaining room
        placed = False
        for at in reversed(hyphen_points(word.text)):
            left, right = split_word(word, at)
            if line_width + space + width_of(left, size) <= avail:
                current.append(left)
                queue.insert(0, right)
                placed = True
                break
        lines.append((current, False, indent if first else 0))
        first = False
        if placed:
            current, line_width = [], 0
        else:
            current, line_width = [word], w
    if current:
        lines.append((current, True, indent if first else 0))
    return lines


class Doc:
    def __init__(self, path, *, scan=False, fake_bold=False, head="", seed=1):
        # invariant: no timestamp or random document id, so the bytes repeat.
        self.c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
        self.scan = scan
        self.fake_bold = fake_bold
        self.head = head
        self.page = 0
        self.rng = random.Random(seed)
        self.skew = math.radians(0.35) if scan else 0.0
        self.new_page()

    # Coordinates are laid out unskewed and skewed on the way to the page.
    def at(self, x, y):
        if not self.skew:
            return x, y
        cx, cy = 306, 396
        dx, dy = x - cx, y - cy
        return cx + dx * math.cos(self.skew) - dy * math.sin(self.skew), cy + dx * math.sin(self.skew) + dy * math.cos(self.skew)

    def new_page(self):
        if self.page > 0:
            self.c.showPage()
        self.page += 1
        if self.head:
            self.draw_centered(self.head.upper(), 306, 750, 8.5)
        self.draw_centered(str(self.page), 306, 40, 9)
        if self.scan:
            stamp = "This content downloaded from 128.59.222.107 on Tue, 12 Mar 2024 14:03:12 UTC All use subject to https://about.jstor.org/terms"
            self.draw_centered(stamp, 306, 22, 6)

    def draw_centered(self, text, cx, y, size, font="Serif"):
        w = pdfmetrics.stringWidth(text, FONTS[font], size)
        self.draw_word_text(text, cx - w / 2, y, size, font)

    def draw_word_text(self, text, x, y, size, font="Serif", scale=1.0):
        """One text object. For a scan: invisible, per word, with the OCR layer's quirks."""
        if not self.scan:
            t = self.c.beginText()
            t.setFont(FONTS[font], size * scale)
            t.setTextOrigin(x, y)
            t.textOut(text)
            self.c.drawText(t)
            return
        for m in re.finditer(r"\S+", text):
            wx = x + pdfmetrics.stringWidth(text[: m.start()], FONTS[font], size * scale)
            self.draw_scan_word(m.group(0), wx, y, size * scale, font)

    def draw_scan_word(self, text, x, y, size, font):
        px, py = self.at(x, y)
        py += self.rng.uniform(-0.4, 0.4)
        real = pdfmetrics.stringWidth(text, FONTS[font], size)
        # OCR layers set their own size per word and stretch it to the box.
        ocr_size = size * self.rng.uniform(0.92, 1.08)
        ocr_width = pdfmetrics.stringWidth(text, FONTS["Serif"], ocr_size) or 1
        t = self.c.beginText()
        t.setTextRenderMode(3)
        t.setFont(FONTS["Serif"], ocr_size)
        t.setHorizScale(100 * real / ocr_width)
        t.setTextOrigin(px, py)
        t.textOut(text)
        self.c.drawText(t)

    def draw_line(self, words, x, y, width, size, justify, marker_notes):
        natural = sum(width_of(w, size) for w in words)
        space = pdfmetrics.stringWidth(" ", FONTS["Serif"], size)
        gap = space
        if justify and len(words) > 1:
            gap = (width - natural) / (len(words) - 1)
        cursor = x
        for word in words:
            for p in word.pieces:
                fs = size * p.scale
                self.draw_word_text(p.text, cursor, y + p.rise, fs, p.font)
                if self.fake_bold and p.font == "Serif-Bold":
                    self.draw_word_text(p.text, cursor + 0.3, y + p.rise, fs, p.font)
                cursor += pdfmetrics.stringWidth(p.text, FONTS[p.font], fs)
            if word.note is not None:
                mark = str(word.note)
                self.draw_word_text(mark, cursor + 0.3, y + size * 0.38, size * 0.6)
                cursor += pdfmetrics.stringWidth(mark, FONTS["Serif"], size * 0.6) + 0.3
                marker_notes.append(word.note)
            cursor += gap


def typeset(name, blocks, notes, *, article, scan=False, fake_bold=False, cover=False):
    doc = Doc(OUT / f"{name}.pdf", scan=scan, fake_bold=fake_bold, head="Comparative Politics" if article else "Chapter 3 · The Politics of Reform", seed=11)
    expected = []
    if cover:
        cover_text = (
            "JSTOR is a not-for-profit service that helps scholars, researchers, and students discover, use, and build upon a wide "
            "range of content in a trusted digital archive. We use information technology and tools to increase productivity and "
            "facilitate new forms of scholarship. For more information about JSTOR, please contact support@jstor.org. Your use of "
            "the JSTOR archive indicates your acceptance of the Terms & Conditions of Use, available at https://about.jstor.org/terms"
        )
        rng = random.Random(5)
        y = 600
        for line, _, _ in break_lines(words_of(cover_text, rng, style="Serif"), 10, 440, 0):
            doc.draw_line(line, 86, y, 440, 10, True, [])
            y -= 13
        doc.new_page()

    top, bottom = 720, 60
    if article:
        columns = [(72, 225), (315, 225)]
    else:
        columns = [(86, 440)]
    col = 0
    y = top
    note_space = [0.0]  # footnote height reserved in the current column
    pending_notes = []  # notes owed to the current column

    def column_bottom():
        return bottom + note_space[0]

    def flush_notes():
        if not pending_notes:
            return
        x, w = (columns[col] if article else columns[0])
        ny = bottom + note_space[0] - 4
        doc.c.setLineWidth(0.4)
        if not scan:
            doc.c.line(x, ny + 2, x + 60, ny + 2)
        ny -= SIZES["note"] * LEADING
        for number in pending_notes:
            nwords = [Word([Piece(f"{number}")])] + words_of(notes[number - 1], random.Random(number), style="Serif")
            for line, last, _ in break_lines(nwords, SIZES["note"], w, 0):
                doc.draw_line(line, x, ny, w, SIZES["note"], not last, [])
                ny -= SIZES["note"] * LEADING
        pending_notes.clear()
        note_space[0] = 0

    def next_column():
        nonlocal col, y
        flush_notes()
        col += 1
        if col >= len(columns):
            doc.new_page()
            col = 0
        y = top

    def note_height(number, width):
        nwords = [Word([Piece("0")])] + words_of(notes[number - 1], random.Random(number), style="Serif")
        return len(break_lines(nwords, SIZES["note"], width, 0)) * SIZES["note"] * LEADING + 8

    full_width_until = None
    for index, block in enumerate(blocks):
        kind = block["kind"]
        size = SIZES[kind]
        lead = size * LEADING
        if article and kind in ("title", "center", "abstract"):
            x, width = 72, 468
            if kind == "abstract":
                x, width = 100, 412
            y -= 4 if kind != "title" else 0
            for line, last, _ in break_lines(block["words"], size, width, 0):
                if kind in ("title", "center"):
                    w = sum(width_of(wd, size) for wd in line) + pdfmetrics.stringWidth(" ", FONTS["Serif"], size) * (len(line) - 1)
                    doc.draw_line(line, 306 - w / 2, y, w, size, False, [])
                else:
                    doc.draw_line(line, x, y, width, size, not last, [])
                y -= lead
            y -= 10
            expected.append(("heading" if kind == "title" else "body", block["plain"]))
            full_width_until = y
            if kind == "abstract":
                top = y  # columns start below the abstract on this page
            continue

        x, width = columns[col]
        indent, right = 0, 0
        if kind == "quote":
            indent_left = 30 if not article else 16
            x, width = x + indent_left, width - 2 * indent_left
        if kind in ("h1", "h2"):
            y -= 8
        if kind == "quote":
            y -= 5
        para_indent = 0 if kind in ("h1", "h2", "quote") or block.get("first") else (18 if not article else 12)
        lines = break_lines(block["words"], size, width, para_indent)
        for line, last, ind in lines:
            owed = [w.note for w in line if w.note is not None]
            need = sum(note_height(n, columns[col][1]) for n in owed)
            if y - lead < column_bottom() + need:
                next_column()
                x0, w0 = columns[col]
                if kind == "quote":
                    x, width = x0 + (30 if not article else 16), w0 - 2 * (30 if not article else 16)
                else:
                    x, width = x0, w0
            note_space[0] += need
            pending_notes.extend(owed)
            doc.draw_line(line, x + ind, y, width - ind, size, not last and kind not in ("h1", "h2"), [])
            y -= lead
        if kind in ("h1", "h2"):
            y -= 4
        if kind == "quote":
            y -= 5
        expected.append(("heading" if kind in ("h1", "h2") else "body", block["plain"]))
    flush_notes()
    doc.c.save()
    (OUT / f"{name}.expected.json").write_text(
        json.dumps({"blocks": expected, "notes": notes}, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(name, doc.page, "pages", len(expected), "blocks", len(notes), "notes")


chapter_blocks, chapter_notes = build_content(3, article=False)
typeset("chapter", chapter_blocks, chapter_notes, article=False)
typeset("scan", chapter_blocks, chapter_notes, article=False, scan=True, cover=True)
typeset("bold", chapter_blocks, chapter_notes, article=False, fake_bold=True)
article_blocks, article_notes = build_content(7, article=True)
typeset("article", article_blocks, article_notes, article=True)
