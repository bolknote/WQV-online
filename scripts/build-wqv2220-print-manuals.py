#!/usr/bin/env python3
"""Render the transcribed Casio 2220 booklet editions and update the manual catalog."""
import hashlib
import html
import json
import re
from itertools import groupby
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/manuals/wqv2220-print-transcription.json'
OUTPUT = ROOT / 'dist/manuals'


def render_text(text, prefix, page_count):
    reference = re.compile(rf'\b{re.escape(prefix)}[-–](\d{{1,2}})\b')
    pieces = []
    offset = 0
    for match in reference.finditer(text):
        number = int(match[1])
        if 1 <= number <= page_count:
            pieces += [html.escape(text[offset:match.start()]),
                       f'<a href="#page-{number}"><bdi>{html.escape(match[0])}</bdi></a>']
            offset = match.end()
    return ''.join(pieces) + html.escape(text[offset:])


def render_figure(figure, caption):
    asset = figure['file']
    if not re.fullmatch(r'wqv2-print/[a-zA-Z-]+-\d{2}-\d{2}\.png', asset):
        raise ValueError(f'Unexpected figure path {asset}')
    if not (OUTPUT / 'assets' / asset).is_file():
        raise FileNotFoundError(asset)
    width, height = figure['size']
    shown_width = min(610, max(90, width * .52))
    shown_height = shown_width * height / width
    wrapper = ('<div class="diagram-viewport" tabindex="0" role="region" '
               f'aria-label="{html.escape(caption)}">')
    picture = (
        f'<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{html.escape(caption)}" '
        f'viewBox="0 0 {width} {height}" width="{shown_width:.1f}" height="{shown_height:.1f}">'
        f'<image href="assets/{asset}" width="{width}" height="{height}"/></svg>'
    )
    return f'<figure class="illustration">{wrapper}{picture}</div></figure>'


def render_edition(code, edition):
    pages = edition['pages']
    title = 'WQV-1/2 — ' + edition['title']
    headings = []
    body = []
    figures = 0
    for number, page in enumerate(pages, 1):
        if page['number'] != number or page['label'] != f"{edition['prefix']}-{number}":
            raise ValueError(f'{code}: wrong order on page {number}')
        label = html.escape(page['label'])
        body.append(f'<section class="source-page" id="page-{number}" data-page="{number}">')
        body.append(f'<p class="page-label"><bdi>{label}</bdi></p>')
        if page.get('note'):
            body.append('<p class="source-note">' + html.escape(page['note']) + '</p>')
        for kind, items in groupby(enumerate(page['blocks']), key=lambda pair: pair[1]['kind']):
            chunk = list(items)
            if kind in ('index', 'bullet', 'step'):
                css = ' class="manual-index"' if kind == 'index' else ''
                tag = 'ol' if kind == 'step' else 'ul'
                start = f' start="{chunk[0][1]["number"]}"' if kind == 'step' else ''
                body.append(f'<{tag}{css}{start}>')
                for _, item in chunk:
                    if kind == 'index' and 1 <= item.get('page', 0) <= len(pages):
                        target = item['page']
                        text = html.escape(item['text'])
                        text = f'<a href="#page-{target}">{text} <bdi>{edition["prefix"]}-{target}</bdi></a>'
                    else:
                        text = render_text(item['text'], edition['prefix'], len(pages))
                    value = f' value="{item["number"]}"' if kind == 'step' else ''
                    body.append(f'<li{value}>{text}</li>')
                body.append(f'</{tag}>')
            elif kind == 'figure':
                for _, item in chunk:
                    body.append(render_figure(page['figures'][item['index']], edition['illustration'] + ' · ' + page['label']))
                    figures += 1
            elif kind in ('h2','h3','p'):
                for index, item in chunk:
                    if kind == 'p':
                        body.append('<p>' + render_text(item['text'], edition['prefix'], len(pages)) + '</p>')
                    else:
                        anchor = f'section-{number}-{index}'
                        body.append(f'<{kind} id="{anchor}">{html.escape(item["text"])}</{kind}>')
                        headings.append({'id': anchor, 'text': item['text']})
            else:
                raise ValueError(f'{code}, page {number}: unknown block {kind}')
        body.append('</section>')
    identifier = f'wqv2-{code}'
    filename = identifier + '.html'
    direction = ' dir="rtl"' if code == 'ar' else ''
    document = (
        f'<!doctype html>\n<html lang="{code}"{direction}><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(title)}</title><link rel="stylesheet" href="document.css"></head><body>'
        f'<article class="print-transcription" data-pages="{len(pages)}"><h1>{html.escape(title)}</h1>'
        f'<p class="source-note">{html.escape(edition["sourceNote"])}</p>\n'
        + '\n'.join(body) + '\n<footer>CASIO COMPUTER CO., LTD. · Module 2220</footer></article></body></html>\n'
    )
    (OUTPUT / filename).write_text(document)
    hashes = '\n'.join(page['source']['sha256'] for page in pages).encode()
    return dict(
        id=identifier, model='WQV-1/2', language=code, module=2220, title=title,
        pages=len(pages), file=filename, sourceURL=None,
        sourceSHA256=hashlib.sha256(hashes).hexdigest(),
        printSource={'kind': 'photographed Casio booklet', 'pageLabels': [page['label'] for page in pages]},
        scanned=True, illustrations=figures, headings=headings,
    )


def main():
    source = json.loads(SOURCE.read_text())
    catalog_file = OUTPUT / 'manifest.json'
    catalog = {item['id']: item for item in json.loads(catalog_file.read_text())}
    for code, edition in source.items():
        item = render_edition(code, edition)
        catalog[item['id']] = item
        print(f'{code}: {item["pages"]} pages, {item["illustrations"]} illustrations')
    catalog_file.write_text(json.dumps(list(catalog.values()), ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
