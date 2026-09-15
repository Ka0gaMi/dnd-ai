#!/usr/bin/env python3
"""Extract the SRD 5.2.1 Rules Glossary and Spells-chapter rules from the official PDF into srd/srd-5.2.1/.

The PDF is the authoritative CC-BY-4.0 document. The outline gives the chapter boundaries and rule-entry
headings are GillSans-SemiBold at >= 11.5pt (chapter/section titles match that too and are filtered by name;
spell stat-block field labels use the same font at 9.5pt and never match). Line-break hyphenation is rejoined,
page furniture is dropped, and titled margin sidebars become their own entries with their own column, so a
sidebar cannot swallow the tail of the paragraph it floats beside. The result is checked against a required
name list, a count range and a no-duplicates rule, and a missing terminator is fatal, so a changed upstream
document fails loudly instead of shipping a gap.

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

FURNITURE = re.compile(r'^(System Reference Document 5\.2\.1|\d+)$')
HEADING_SIZE = 11.5
# A sidebar sits in the margin, so its lines share an x offset the body text does not.
SIDEBAR_COLUMN_TOLERANCE = 40


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
    return ''.join(span['text'] for span in line['spans']).strip()


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
    """Ordered (kind, text, x0) lines from the `first` heading up to (but excluding) the `last` heading, with
    page furniture removed, plus whether `last` was actually reached. Both ends cut on the heading itself, not
    the page, so neighbouring chapters cannot leak in."""
    collected: list[tuple[str, str, float]] = []
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
                if kind is not None:
                    if not started:
                        # A titled sidebar (e.g. "Casting in Armor") can precede the first rule heading.
                        if kind == 'sidebar' or text == first:
                            started = True
                        else:
                            continue
                    elif text == last:
                        return collected, True
                    collected.append((kind, text, line['bbox'][0]))
                    continue
                if started:
                    collected.append(('body', text, line['bbox'][0]))
    return collected, False


def reflow(lines) -> str:
    """Rejoins line-break hyphenation, then wraps the entry back into one line."""
    text = '\n'.join(lines)
    text = re.sub(r'([A-Za-z])-\n([a-z])', r'\1\2', text)
    paragraphs = [re.sub(r'\s+', ' ', part).strip() for part in re.split(r'\n\s*\n', text)]
    return '\n\n'.join(part for part in paragraphs if part)


def normalise(text: str) -> str:
    text = text.replace('\u2019', "'").replace('\u2018', "'").replace('\u201c', '"').replace('\u201d', '"')
    return re.sub(r'[ \t]+', ' ', text).strip()


def split_entries(lines, skip: set[str]):
    """Slices a heading/body stream into (name, desc), dropping section headings named in `skip`.

    A sidebar owns only the lines in its own margin column; a line in the body column while a sidebar is open
    belongs to the entry before it, which is how a paragraph floating beside a sidebar keeps its tail."""
    entries: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    previous: tuple[str, list[str]] | None = None
    sidebar_x: float | None = None
    for kind, text, x0 in lines:
        if kind == 'body':
            target = current
            if sidebar_x is not None and abs(x0 - sidebar_x) > SIDEBAR_COLUMN_TOLERANCE:
                target = previous if previous is not None else current
            if target is not None:
                target[1].append(text)
            continue
        if text in skip:
            current = previous = None
            sidebar_x = None
            continue
        previous = current
        current = (text, [])
        entries.append(current)
        sidebar_x = x0 if kind == 'sidebar' else None
    return [(normalise(name), normalise(reflow(body))) for name, body in entries if body]


def assert_entries(entries, required, label, low, high):
    names = [name.split(' [')[0] for name, _ in entries]
    missing = [name for name in required if name not in names]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if not low <= len(entries) <= high or missing or duplicates:
        raise SystemExit(
            f'{label}: {len(entries)} entries (expected {low}-{high}); '
            f'missing {missing or "none"}; duplicates {duplicates or "none"}'
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
        glossary = split_entries(glossary_lines, {'Rules Glossary', 'Rules Definitions'})
        write_json(OUT_DIR / 'RulesGlossary.json', assert_entries(glossary, GLOSSARY_REQUIRED, 'Rules Glossary', 150, 170))

        spell_lines, spell_end = lines_between(doc, 'Gaining Spells', 'Spell Descriptions')
        if not spell_end:
            raise SystemExit('Spell rules: never reached the "Spell Descriptions" terminator')
        spells = split_entries(spell_lines, {'Spells'})
        write_json(OUT_DIR / 'SpellRules.json', assert_entries(spells, SPELL_RULES_REQUIRED, 'Spell rules', 25, 30))
    finally:
        if temporary is not None:
            temporary.cleanup()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
