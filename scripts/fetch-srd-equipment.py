#!/usr/bin/env python3
"""Extract every priced item of the SRD 5.2.1 Equipment chapter from the official PDF into
srd/srd-5.2.1/Equipment.json: its titled tables, plus the tools, whose prices are printed in their headings.

Requires: pip install pymupdf  (AGPL-3.0; see srd/ATTRIBUTION.md). Verified with pymupdf 2.0 on Python 3.14.
Usage:    python scripts/fetch-srd-equipment.py [--pdf PATH]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import tempfile
from pathlib import Path

# The download, bookmark, page-furniture and line-joining helpers are the rules extraction's own.
_spec = importlib.util.spec_from_file_location('fetch_srd_pdf', Path(__file__).with_name('fetch-srd-pdf.py'))
rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rules)

OUT = rules.OUT_DIR / 'Equipment.json'
TABLES = (
    'Weapons', 'Armor', 'Adventuring Gear', 'Ammunition', 'Arcane Focuses', 'Druidic Focuses', 'Holy Symbols',
    'Mounts and Other Animals', 'Tack, Harness, and Drawn Vehicles', 'Airborne and Waterborne Vehicles',
    'Food, Drink, and Lodging',
)
# Rates and services rather than goods: a coin's worth, a hireling's day, a spell cast, a scroll scribed.
SKIPPED = ('Coin Values', 'Hirelings', 'Spellcasting Services', 'Spell Scroll Costs')
# One printed price per kind of row, the three 5e-bits got wrong among them: a reshaped extraction fails here.
PINS = {
    'Spear': '1 GP', 'Javelin': '5 SP', 'Longbow': '50 GP', 'Dart': '5 CP', 'Plate Armor': '1,500 GP',
    "Thieves' Tools": '25 GP', 'lute': '35 GP', 'Spyglass': '1,000 GP', 'Bullets, Sling': '4 CP',
    'Yew wand': '10 GP', 'Reliquary (held)': '5 GP', 'Warhorse': '400 GP', 'Exotic': '60 GP',
    'Airship': '40,000 GP', 'Fine': '10 GP',
}
COUNT = (220, 230)
TITLE_SIZE = (10.3, 10.7)
CELL_SIZE = (9.1, 9.7)
# A row's cells share a baseline to within this; a wrapped cell's next line sits a full line lower.
ROW_TOLERANCE = 2
# A row set this far right of its header's first column belongs to the italic group row above it.
INDENT = 4
COST = re.compile(r'([\d,]+) (CP|SP|EP|GP|PP)')
WEIGHT = re.compile(r'(\d+)?(½)?(?:(\d+)/(\d+))? lb\.(?: \(full\))?')
TOOL = re.compile(r'(.+) \((?:([\d,]+ [CSEGP]P)|Varies)\)')
FIELD = re.compile(r'(Ability|Weight|Utilize|Craft|Variants): ?(.*)')
VARIANT = re.compile(r'([^,(]+?) \(([\d,]+ [CSEGP]P)(?:, ([^)]+))?\)')


def kind(line) -> str | None:
    """'title', 'header' or 'cell' for a table line, else the rules extraction's heading level or None."""
    spans = [span for span in line['spans'] if span['text'].strip()]
    size = max(span['size'] for span in spans)
    gill = all(span['font'].startswith('GillSans') for span in spans)
    semibold = all('SemiBold' in span['font'] for span in spans)
    if gill and semibold and TITLE_SIZE[0] <= size <= TITLE_SIZE[1]:
        return 'title'
    if gill and CELL_SIZE[0] <= size <= CELL_SIZE[1]:
        return 'header' if semibold else 'cell'
    return rules.is_heading(line)


def chapter_lines(doc):
    """Every printed line of the Equipment chapter as a record, page furniture dropped, with its 18pt section."""
    section = None
    for page in range(rules.page_of(doc, 'Equipment'), rules.page_of(doc, 'Spells') + 1):
        height = doc[page].rect.height
        for block in doc[page].get_text('dict')['blocks']:
            for line in block.get('lines', []):
                text = rules.line_text(line)
                if not text or rules.is_furniture(line, text, height):
                    continue
                spans = [span for span in line['spans'] if span['text'].strip()]
                record = {
                    'kind': kind(line), 'text': rules.normalise(text), 'page': page,
                    'x0': line['bbox'][0], 'x1': line['bbox'][2], 'y': line['bbox'][1],
                    'italic': all('Italic' in span['font'] for span in spans),
                }
                if record['kind'] == 'section':
                    section = record['text']
                yield section, record


def table_runs(lines):
    """(title or None, cells) for each unbroken run of table cells outside "Tools"; a title opens the run under it."""
    title, cells = None, []
    for section, record in lines:
        if section != 'Tools' and record['kind'] in ('header', 'cell'):
            cells.append(record)
            continue
        if cells:
            yield title, cells
        title, cells = (record['text'] if record['kind'] == 'title' else None), []
    if cells:
        yield title, cells


def segments(cells):
    """A run split at each header row: one (header, body) per printed half, column or page of a table."""
    out: list[tuple[list[dict], list[dict]]] = []
    for cell in cells:
        if cell['kind'] == 'header' and (not out or out[-1][1]):
            out.append(([], []))
        if not out:
            raise SystemExit(f'table cell before any header row: {cell["text"]!r}')
        out[-1][0 if cell['kind'] == 'header' else 1].append(cell)
    return out


def rows(header, body):
    """The body as rows of {column index: text}, each cell under the header column its span overlaps most."""
    out: list[list[dict]] = []
    for cell in sorted(body, key=lambda c: c['y']):
        if out and abs(out[-1][0]['y'] - cell['y']) < ROW_TOLERANCE:
            out[-1].append(cell)
        else:
            out.append([cell])
    placed = []
    for row in out:
        columns: dict[int, dict] = {}
        for cell in sorted(row, key=lambda c: c['x0']):
            overlap = [min(cell['x1'], h['x1']) - max(cell['x0'], h['x0']) for h in header]
            at = max(range(len(header)), key=lambda i: (overlap[i], -abs(header[i]['x0'] - cell['x0'])))
            columns[at] = {**cell, 'text': rules.join(columns[at]['text'], cell['text'])} if at in columns else cell
        placed.append(columns)
    return placed


def ref(name: str) -> dict:
    return {'index': re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-'), 'name': name}


def cost(text: str) -> dict | None:
    """{quantity, unit} as 5e-bits writes a price; None only for the "Varies" of a family row."""
    if text == 'Varies':
        return None
    match = COST.fullmatch(text)
    if not match:
        raise SystemExit(f'unreadable price: {text!r}')
    return {'quantity': int(match[1].replace(',', '')), 'unit': match[2].lower()}


def weight(text: str) -> float | None:
    """Pounds; "—" is 0 as 5e-bits writes a negligible weight, and "Varies" is None."""
    if text == '—':
        return 0
    if text == 'Varies':
        return None
    match = WEIGHT.fullmatch(text)
    if not match or not any(match.groups()):
        raise SystemExit(f'unreadable weight: {text!r}')
    return int(match[1] or 0) + (0.5 if match[2] else 0) + (int(match[3]) / int(match[4]) if match[3] else 0)


def weapon_properties(text: str, entry: dict) -> None:
    """The Properties cell as 5e-bits' fields: property refs, the versatile die, the thrown and ammunition ranges."""
    entry['properties'] = []
    if text == '—':
        return
    for part in re.split(r',\s*(?![^()]*\))', text):
        match = re.fullmatch(r'([A-Za-z-]+)(?: \((.+)\))?', part.strip())
        if not match:
            raise SystemExit(f'unreadable weapon property: {part!r}')
        name, note = match[1], match[2]
        entry['properties'].append(ref(name))
        reach = re.match(r'Range (\d+)/(\d+)(?:; (.+))?$', note or '')
        if name == 'Versatile' and note:
            entry['two_handed_damage'] = {**entry['damage'], 'damage_dice': note}
        elif name in ('Thrown', 'Ammunition') and reach:
            entry['throw_range' if name == 'Thrown' else 'range'] = {'normal': int(reach[1]), 'long': int(reach[2])}
            if reach[3]:
                entry.setdefault('details', {})[name] = reach[3]
        elif note:
            entry.setdefault('details', {})[name] = note


def armor_class(text: str) -> dict:
    match = re.fullmatch(r'(\d+) \+ Dex modifier(?: \(max (\d+)\))?', text)
    if match:
        return {'base': int(match[1]), 'dex_bonus': True, **({'max_bonus': int(match[2])} if match[2] else {})}
    match = re.fullmatch(r'\+?(\d+)', text)
    if not match:
        raise SystemExit(f'unreadable armor class: {text!r}')
    return {'base': int(match[1]), 'dex_bonus': False}


def row_entry(table: str, group: str | None, header: list[str], values: dict[int, str]) -> dict | None:
    """One priced row in 5e-bits' field shapes, the columns 5e-bits has no field for kept as printed."""
    entry: dict = {'name': values[0], 'table': table, **({'group': group} if group else {})}
    for at, text in sorted(values.items()):
        column = header[at]
        if at == 0:
            continue
        if column == 'Cost':
            entry['cost'] = cost(text)
            if entry['cost'] is None:
                return None  # a family row such as "Arcane Focus": its own table prices each kind
        elif column == 'Weight':
            entry['weight'] = weight(text)
        elif column == 'Damage':
            dice, damage_type = text.split(' ', 1)
            entry['damage'] = {'damage_dice': dice, 'damage_type': ref(damage_type)}
        elif column == 'Properties':
            weapon_properties(text, entry)
        elif column == 'Mastery':
            entry['mastery'] = ref(text)
        elif column == 'Armor Class (AC)':
            entry['armor_class'] = armor_class(text)
        elif column == 'Strength':
            entry['str_minimum'] = 0 if text == '—' else int(text.removeprefix('Str '))
        elif column == 'Stealth':
            entry['stealth_disadvantage'] = text == 'Disadvantage'
        elif column == 'Amount':
            entry['quantity'] = int(text)
        else:
            entry.setdefault('details', {})[column] = text
    if 'cost' not in entry:
        raise SystemExit(f'{table}: no price for {values[0]!r}')
    return entry


def table_items(doc) -> tuple[dict[str, list[dict]], set[str]]:
    """Every priced row of the titled tables, by table, plus every table title the chapter prints."""
    items: dict[str, list[dict]] = {}
    headers: dict[str, list[str]] = {}
    groups: dict[str, str | None] = {}
    titles: set[str] = set()
    for title, cells in table_runs(chapter_lines(doc)):
        if title is not None:
            titles.add(title)
        for index, (header, body) in enumerate(segments(cells)):
            header = sorted(header, key=lambda h: h['x0'])
            names = [h['text'] for h in header]
            if index == 0 and title is not None:
                table = title
            else:
                # A half or page of a table with no title over it repeats that table's header row.
                table = next((t for t, h in reversed(headers.items()) if h == names), None)
                if table is None:
                    raise SystemExit(f'table cells under an unknown header: {names}')
            if table in SKIPPED:
                continue
            headers[table] = names
            group = groups.get(table)
            for values in rows(header, body):
                cells_in_row = list(values.values())
                if len(cells_in_row) == 1 and cells_in_row[0]['italic']:
                    group = cells_in_row[0]['text']
                    continue
                if 0 not in values:
                    # A cell wrapped onto a second line, such as a long Properties list.
                    last = items[table][-1]
                    for at, cell in values.items():
                        last['_values'][at] = rules.join(last['_values'].get(at, ''), cell['text'])
                    continue
                if values[0]['x0'] <= header[0]['x0'] + INDENT:
                    group = None
                items.setdefault(table, []).append(
                    {'_values': {at: cell['text'] for at, cell in values.items()}, '_group': group, '_header': names}
                )
            groups[table] = group
    parsed = {
        table: [e for e in (row_entry(table, r['_group'], r['_header'], r['_values']) for r in raw) if e is not None]
        for table, raw in items.items()
    }
    return parsed, titles


def tool_items(doc) -> list[dict]:
    """Each priced tool from its heading ("Alchemist's Supplies (50 GP)") and Weight line, plus the priced
    variants of a "(Varies)" tool, which take the tool's weight unless they print their own."""
    tools: list[tuple[str | None, str, str | None, dict[str, str]]] = []
    group = None
    for section, record in chapter_lines(doc):
        if section != 'Tools':
            continue
        if record['kind'] == 'subsection':
            group = record['text']
        elif record['kind'] == 'entry':
            match = TOOL.fullmatch(record['text'])
            if not match:
                raise SystemExit(f'Tools: unreadable tool heading {record["text"]!r}')
            tools.append((group, match[1], match[2], {}))
        elif record['kind'] in ('header', 'cell') and tools:
            fields = tools[-1][3]
            field = FIELD.fullmatch(record['text'])
            if field:
                fields[field[1]] = field[2]
            elif fields:
                last = list(fields)[-1]
                fields[last] = rules.join(fields[last], record['text'])
    out = []
    for group, name, price, fields in tools:
        heft = weight(fields.get('Weight', ''))
        if price:
            out.append({'name': name, 'table': 'Tools', 'group': group, 'cost': cost(price), 'weight': heft})
        for variant in VARIANT.finditer(fields.get('Variants', '')):
            own = weight(variant[3]) if variant[3] else heft
            out.append({'name': variant[1].strip(), 'table': 'Tools', 'group': name, 'cost': cost(variant[2]), 'weight': own})
    return out


def check(entries: list[dict], titles: set[str]) -> None:
    found = {entry['table'] for entry in entries}
    missing = [table for table in TABLES if table not in found]
    unknown = sorted(titles - set(TABLES) - set(SKIPPED))
    keys = [(entry['table'], entry.get('group'), entry['name']) for entry in entries]
    duplicates = sorted({key for key in keys if keys.count(key) > 1}, key=str)
    printed = {entry['name']: entry['cost'] for entry in entries}
    unpinned = sorted(name for name, price in PINS.items() if printed.get(name) != cost(price))
    if not COUNT[0] <= len(entries) <= COUNT[1] or missing or unknown or duplicates or unpinned:
        raise SystemExit(
            f'Equipment: {len(entries)} priced items (expected {COUNT[0]}-{COUNT[1]}); tables missing '
            f'{missing or "none"}; unknown tables {unknown or "none"}; duplicates {duplicates or "none"}; '
            f'without their pinned price {unpinned or "none"}'
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', help='a local SRD 5.2.1 PDF instead of downloading it')
    args = parser.parse_args()

    try:
        import pymupdf
    except ImportError:
        print('pymupdf is not installed; run: pip install pymupdf', file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as temporary:
        pdf_path = Path(args.pdf) if args.pdf else rules.download(rules.PDF_URL, Path(temporary) / 'srd.pdf')
        doc = pymupdf.open(pdf_path)
        tables, titles = table_items(doc)
        # Document order: the Tools section sits between the Armor and Adventuring Gear tables.
        ordered = [*tables.pop('Weapons', []), *tables.pop('Armor', []), *tool_items(doc)]
        entries = ordered + [entry for table in tables.values() for entry in table]
        doc.close()
    check(entries, titles)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Explicit LF bytes, as the rules extraction writes, so the committed blob matches on every platform.
    OUT.write_bytes((json.dumps(entries, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    counts = ', '.join(f'{table} {sum(e["table"] == table for e in entries)}' for table in dict.fromkeys(e['table'] for e in entries))
    print(f'{OUT.relative_to(rules.ROOT)}: {len(entries)} priced items ({counts})')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
