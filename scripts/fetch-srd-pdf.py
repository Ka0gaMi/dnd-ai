#!/usr/bin/env python3
"""Extract the SRD 5.2.1 Rules Glossary and Spells-chapter rules from the official PDF into srd/srd-5.2.1/.

The PDF is the authoritative CC-BY-4.0 document. The outline gives the chapter boundaries and rule-entry
headings are GillSans-SemiBold at >= 11.5pt (chapter/section titles match that too and are filtered by name;
spell stat-block field labels use the same font at 9.5pt and never match). Line-break hyphenation is rejoined,
page furniture is dropped, and titled margin sidebars become their own entries with their own column, so a
sidebar cannot swallow the tail of the paragraph it floats beside.

Each `desc` keeps the shape of the printed entry. Paragraphs are separated by a blank line, taken from the
page's own markers: a leading tab or a bold Cambria run-in heading ("Damage.", "Benefits of the Rest.") starts
one. Bullet items get a line each, and a titled table becomes its own paragraph of ' | '-joined rows with its
header row once, even where the page prints the table as two side-by-side halves or continues it in the next
column. The untitled Gill Sans grids (the abbreviation list, the name lists in "Action" or "Condition") have no
header row and stay as one paragraph in reading order. The result is checked against a required name list with
one pinned phrase each, a count range, a minimum length and a no-duplicates rule, and a missing terminator is
fatal, so a changed upstream document fails loudly instead of shipping a gap.

Requires: pip install pymupdf  (AGPL-3.0; see srd/ATTRIBUTION.md). Verified with pymupdf 1.28 on Python 3.14.
Usage:    python scripts/fetch-srd-pdf.py [--pdf PATH]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

PDF_URL = 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf'
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'srd' / 'srd-5.2.1'

GLOSSARY_REQUIRED = [
    'D20 Test', 'Concentration', 'Unarmed Strike', 'Attunement', 'Heroic Inspiration', 'Passive Perception',
    'Stable', 'Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated',
    'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
    'Long Rest', 'Short Rest', 'Glossary Conventions',
]
SPELL_RULES_REQUIRED = [
    'Casting Time', 'One Spell with a Spell Slot per Turn', 'Range', 'Components', 'Duration', 'Effects',
    'Targets', 'Saving Throws', 'Casting in Armor', 'Identifying an Ongoing Spell',
]
# One phrase per entry that the SRD's wording must still contain: a reshaped extraction fails here.
GLOSSARY_PINS = {
    'Attunement': 'no more than three magic items',
    'Concentration': 'maximum DC of 30',
    'Cover': 'Three-Quarters Cover',
    'D20 Test': 'ability checks, attack rolls, and saving throws',
    'Exhaustion': 'Exhaustion level is 6',
    'Grappled': 'Speed is 0',
    'Heroic Inspiration': 'reroll any die',
    'Long Rest': 'at least 8 hours',
    'Prone': 'Disadvantage on attack rolls',
    'Stable': 'Death Saving Throws',
    'Unarmed Strike': '1 plus your Strength modifier',
}
SPELL_RULES_PINS = {
    'Casting in Armor': 'training with any armor',
    'Components': 'Verbal (V)',
    'One Spell with a Spell Slot per Turn': 'expend only one spell slot',
    'Saving Throws': 'spellcasting ability modifier',
}
MINIMUM_DESC = 40

FURNITURE = re.compile(r'^(System Reference Document 5\.2\.1|\d+)$')
HEADING_SIZE = 11.5
# A sidebar sits in the margin, so its lines share an x offset the body text does not.
SIDEBAR_COLUMN_TOLERANCE = 40
# Titled tables are set in 9.2pt/9.5pt Gill Sans; the untitled grids are 10pt and a sidebar's prose is 9pt.
CELL_SIZE = (9.1, 9.7)
GRID_SIZE = (9.8, 10.2)
TABLE_TITLE_SIZE = (10.3, 10.7)


def download(url: str, dest: Path) -> Path:
    request = urllib.request.Request(
        url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.dndbeyond.com/srd'}
    )
    with urllib.request.urlopen(request) as response, dest.open('wb') as handle:
        handle.write(response.read())
    return dest


def is_heading(line) -> str | None:
    """'entry' for a rule heading, 'sidebar' for a titled sidebar block, else None."""
    biggest = max(line['spans'], key=lambda span: span['size'])
    if biggest['size'] >= HEADING_SIZE and 'SemiBold' in biggest['font']:
        return 'entry'
    if biggest['size'] >= 10.5 and 'Bold-SC700' in biggest['font']:
        return 'sidebar'
    return None


def line_text(line) -> str:
    return re.sub(r'\s+', ' ', ''.join(span['text'] for span in line['spans'])).strip()


def classify(line, text: str) -> tuple[str, bool]:
    """(kind, starts-a-paragraph) for a line that is not a rule heading."""
    raw = ''.join(span['text'] for span in line['spans'])
    spans = [span for span in line['spans'] if span['text'].strip()]
    if text.startswith('\u2022'):
        return 'bullet', False
    if not spans[0]['font'].startswith('GillSans-Light') and all(s['font'].startswith('GillSans') for s in spans):
        size = max(span['size'] for span in spans)
        if CELL_SIZE[0] <= size <= CELL_SIZE[1]:
            return 'cell', False
        if GRID_SIZE[0] <= size <= GRID_SIZE[1]:
            return 'grid', False
        if TABLE_TITLE_SIZE[0] <= size <= TABLE_TITLE_SIZE[1]:
            return 'body', True
    # The page marks a new paragraph with a leading tab or with a bold run-in heading such as "Damage."
    return 'body', raw.startswith('\t') or spans[0]['font'].startswith('Cambria-Bold')


def page_of(doc, title: str) -> int:
    wanted = title.replace(' ', '').lower()
    for _level, name, page in doc.get_toc():
        if str(name).replace(' ', '').lower() == wanted:
            return page - 1
    raise SystemExit(f'bookmark not found: {title}')


def is_furniture(line, text: str, page_height: float) -> bool:
    """Running headers and printed page numbers only. Restricting this to 11pt margin lines matters: a
    standalone digit in a table cell (an object's AC, say) is 9.5pt and must survive."""
    biggest = max(line['spans'], key=lambda span: span['size'])
    if round(biggest['size']) != 11 or not FURNITURE.match(text):
        return False
    top, bottom = line['bbox'][1], line['bbox'][3]
    return top < 70 or bottom > page_height - 70


def lines_between(doc, first: str, last: str):
    """Ordered line records from the `first` heading up to (but excluding) the `last` heading, with page
    furniture removed, plus whether `last` was actually reached. Both ends cut on the heading itself, not the
    page, so neighbouring chapters cannot leak in."""
    collected: list[dict] = []
    started = False
    # A bookmark's page can precede the page its heading prints on, so scan a little past `last` and rely on
    # the heading itself to stop the stream.
    last_page = min(page_of(doc, last) + 3, doc.page_count)
    for page in range(page_of(doc, first), last_page):
        page_height = doc[page].rect.height
        for block in doc[page].get_text('dict')['blocks']:
            if block.get('type') != 0:
                continue
            for line in block['lines']:
                text = line_text(line)
                if not text or is_furniture(line, text, page_height):
                    continue
                kind = is_heading(line)
                paragraph = False
                if kind is not None:
                    if not started:
                        # A titled sidebar (e.g. "Casting in Armor") can precede the first rule heading.
                        if kind == 'sidebar' or text == first:
                            started = True
                        else:
                            continue
                    elif text == last:
                        return collected, True
                elif started:
                    kind, paragraph = classify(line, text)
                else:
                    continue
                collected.append({
                    'kind': kind, 'text': text, 'paragraph': paragraph, 'page': page,
                    'x0': line['bbox'][0], 'y': line['bbox'][1],
                })
    return collected, False


def join(left: str, right: str) -> str:
    """Appends a printed line to the one before it, closing a hyphen or em-dash break with no space."""
    if not left or not right:
        return left or right
    if re.search(r'[A-Za-z]-$', left) and re.match(r'[a-z]', right):
        return left[:-1] + right
    if left.endswith('\u2014'):
        return left + right
    return f'{left} {right}'


def table_parts(cells):
    """A table's cells as parts of rows, each part sharing one set of columns. A table printed in two
    side-by-side halves, or continued in the next page column, yields one part per half."""
    rows: list[list[dict]] = []
    for cell in cells:
        # A row is the cells sharing a baseline, which the page can print as several blocks.
        row = next(
            (r for r in reversed(rows)
             if r[0]['page'] == cell['page'] and abs(r[0]['y'] - cell['y']) < 2 and r[-1]['x0'] < cell['x0']),
            None,
        )
        if row is None:
            rows.append([cell])
        else:
            row.append(cell)
    segments: list[list[list[dict]]] = []
    for row in rows:
        # Rows only ever descend within a page column, so a step back up is the table's next column.
        previous = segments[-1][-1][0] if segments else None
        if previous is not None and previous['page'] == row[0]['page'] and previous['y'] < row[0]['y']:
            segments[-1].append(row)
        else:
            segments.append([row])
    parts = []
    for segment in segments:
        header = [cell['text'] for cell in segment[0]]
        half = len(header) // 2
        if half and header[:half] == header[half:]:
            edge = segment[0][half]['x0'] - 4
            parts.append([[cell for cell in row if cell['x0'] < edge] for row in segment])
            parts.append([[cell for cell in row if cell['x0'] >= edge] for row in segment])
        else:
            parts.append(segment)
    return [[row for row in part if row] for part in parts]


def table_lines(cells) -> list[str]:
    """One ' | '-joined line per table row, with the header row kept once however the page splits the table."""
    rendered: list[list[str]] = []
    header: list[str] = []
    for part in table_parts(cells):
        columns = [cell['x0'] for cell in part[0]]
        for row in part:
            values = [''] * len(columns)
            for cell in row:
                at = min(range(len(columns)), key=lambda index: abs(columns[index] - cell['x0']))
                values[at] = join(values[at], cell['text'])
            filled = [value for value in values if value]
            if not header:
                header = filled
            elif filled == header:
                continue  # the header, printed again over the split
            if rendered and not values[0] and len(values) == len(rendered[-1]):
                rendered[-1] = [join(a, b) for a, b in zip(rendered[-1], values)]  # a cell wrapped onto a line
                continue
            rendered.append(values)
    return [' | '.join(value for value in values if value) for values in rendered]


def reflow(records) -> str:
    """Rebuilds an entry's text: paragraphs separated by a blank line, bullets and table rows one line each."""
    paragraphs: list[list[str]] = []
    mode: str | None = None
    bullet_x = 0.0
    index = 0
    while index < len(records):
        kind = records[index]['kind']
        if kind in ('cell', 'grid'):
            run = index
            while run < len(records) and records[run]['kind'] == kind:
                run += 1
            run_records = records[index:run]
            paragraphs.append(
                table_lines(run_records) if kind == 'cell' else [' '.join(r['text'] for r in run_records)]
            )
            # The PDF sets the first paragraph after a table or grid flush left, with no tab or bold marker,
            # so the line that follows starts a paragraph of its own.
            index, mode = run, None
            continue
        record = records[index]
        index += 1
        if kind == 'bullet':
            if mode != 'bullets':
                paragraphs.append([])
                mode, bullet_x = 'bullets', record['x0']
            paragraphs[-1].append(record['text'])
        elif mode == 'bullets' and record['x0'] > bullet_x + 4:
            paragraphs[-1][-1] = join(paragraphs[-1][-1], record['text'])
        elif mode == 'prose' and not record['paragraph']:
            paragraphs[-1][-1] = join(paragraphs[-1][-1], record['text'])
        else:
            paragraphs.append([record['text']])
            mode = 'prose'
    return '\n\n'.join('\n'.join(lines) for lines in paragraphs if any(lines))


def normalise(text: str) -> str:
    text = text.replace('\u2019', "'").replace('\u2018', "'").replace('\u201c', '"').replace('\u201d', '"')
    return re.sub(r'[ \t]+', ' ', text).strip()


def split_entries(records, skip: set[str], label: str):
    """Slices a heading/body stream into (name, desc), dropping section headings named in `skip`.

    A sidebar owns only the lines in its own margin column; a line in the body column while a sidebar is open
    belongs to the entry before it, which is how a paragraph floating beside a sidebar keeps its tail. Text
    under a skipped section heading belongs to no entry, so it is reported rather than silently dropped."""
    entries: list[tuple[str, list[dict]]] = []
    current: tuple[str, list[dict]] | None = None
    previous: tuple[str, list[dict]] | None = None
    sidebar_x: float | None = None
    for record in records:
        text = record['text']
        if record['kind'] not in ('entry', 'sidebar'):
            target = current
            if sidebar_x is not None and abs(record['x0'] - sidebar_x) > SIDEBAR_COLUMN_TOLERANCE:
                target = previous if previous is not None else current
            if target is None:
                print(f'{label}: skipped section text, belongs to no entry: {text!r}', file=sys.stderr)
            else:
                target[1].append(record)
            continue
        if text in skip:
            current = previous = None
            sidebar_x = None
            continue
        previous = current
        current = (text, [])
        entries.append(current)
        sidebar_x = record['x0'] if record['kind'] == 'sidebar' else None
    return [(normalise(name), normalise(reflow(body))) for name, body in entries if body]


def assert_entries(entries, required, pins, label, low, high):
    names = [name.split(' [')[0] for name, _ in entries]
    described = {name.split(' [')[0]: desc for name, desc in entries}
    missing = [name for name in required if name not in names]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    short = sorted(name for name, desc in entries if len(desc) < MINIMUM_DESC)
    unpinned = sorted(name for name, phrase in pins.items() if phrase not in described.get(name, ''))
    if not low <= len(entries) <= high or missing or duplicates or short or unpinned:
        raise SystemExit(
            f'{label}: {len(entries)} entries (expected {low}-{high}); '
            f'missing {missing or "none"}; duplicates {duplicates or "none"}; '
            f'under {MINIMUM_DESC} characters {short or "none"}; without their pinned text {unpinned or "none"}'
        )
    return entries


def write_json(path: Path, entries) -> None:
    payload = [{'name': name, 'desc': desc} for name, desc in entries]
    # Write bytes with an explicit LF so the committed blob and this output are identical on every platform.
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n'
    path.write_bytes(body.encode('utf-8'))
    print(f'{path.relative_to(ROOT)}: {len(payload)} entries')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', help='a local SRD 5.2.1 PDF instead of downloading it')
    args = parser.parse_args()

    try:
        import pymupdf
    except ImportError:
        print('pymupdf is not installed; run: pip install pymupdf', file=sys.stderr)
        return 1

    temporary: tempfile.TemporaryDirectory | None = None
    if args.pdf:
        pdf_path = Path(args.pdf)
    else:
        temporary = tempfile.TemporaryDirectory()
        pdf_path = download(PDF_URL, Path(temporary.name) / 'srd.pdf')

    try:
        doc = pymupdf.open(pdf_path)
        OUT_DIR.mkdir(parents=True, exist_ok=True)

        glossary_lines, glossary_end = lines_between(doc, 'Rules Glossary', 'Gameplay Toolbox')
        if not glossary_end:
            raise SystemExit('Rules Glossary: never reached the "Gameplay Toolbox" terminator')
        glossary = split_entries(glossary_lines, {'Rules Glossary', 'Rules Definitions'}, 'Rules Glossary')
        write_json(
            OUT_DIR / 'RulesGlossary.json',
            assert_entries(glossary, GLOSSARY_REQUIRED, GLOSSARY_PINS, 'Rules Glossary', 150, 170),
        )

        spell_lines, spell_end = lines_between(doc, 'Gaining Spells', 'Spell Descriptions')
        if not spell_end:
            raise SystemExit('Spell rules: never reached the "Spell Descriptions" terminator')
        spells = split_entries(spell_lines, {'Spells'}, 'Spell rules')
        write_json(
            OUT_DIR / 'SpellRules.json',
            assert_entries(spells, SPELL_RULES_REQUIRED, SPELL_RULES_PINS, 'Spell rules', 25, 30),
        )
    finally:
        if temporary is not None:
            temporary.cleanup()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
