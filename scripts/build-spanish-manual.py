#!/usr/bin/env python3
"""Build the Spanish module 2220 guide from reviewed OCR and original crops.

Source PDF and word-coordinate Tesseract caches stay in research/manuals.
The published review records the source hash, corrections and crop rectangles.
"""
from pathlib import Path
import hashlib, html, importlib.util, json, re
import pymupdf as fitz

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('german_builder', ROOT/'scripts/build-german-manuals.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def clean(text):
    text = re.sub(r'^(?:•\s*e\s+|e\s+|[+>]\s+)', '• ', text)
    text = re.sub(r'^\|\s*|\s*[—_\]]+$', '', text).strip()
    for old, new in {'Enel ': 'En el ', 'Acada ': 'A cada ', 'Silo ': 'Si lo ',
                     'memoría': 'memoria', 'techa': 'fecha', 'resposo': 'reposo',
                     'cambiario': 'cambiarlo', '1R': 'IR'}.items():
        text = text.replace(old, new)
    return text


def paragraph_text(parts):
    text = shared.paragraph_text(parts)
    return re.sub(r'\s+', ' ', text).strip()


def build():
    review = json.loads((ROOT/'docs/manuals/spanish-proofreading.json').read_text())
    source = ROOT/'research/manuals/sources/wqv2-es.pdf'
    assert hashlib.sha256(source.read_bytes()).hexdigest() == review['sourceSHA256'], 'Source PDF changed'
    doc = fitz.open(source)
    output = ROOT/'dist/manuals'
    assets = output/'assets'
    body, headings, figure_count = [], [], 0
    for number, page in enumerate(doc, 1):
        entry = review['pages'][str(number)]
        if not entry['reviewed']:
            raise ValueError(f'Spanish page {number} has not been reviewed')
        cache = ROOT/f'research/manuals/ocr/wqv2-es/page-{number:02}.json'
        assert hashlib.sha256(cache.read_bytes()).hexdigest() == entry['ocrSHA256'], f'OCR changed on page {number}; recheck its corrections'
        data = json.loads(cache.read_text())
        figures = [fitz.Rect(box) for box in entry['figures']]
        blocks = [{**block, 'box': fitz.Rect(block['rect']), 'kind': 'block'} for block in entry.get('blocks', [])]
        masks = figures + [block['box'] for block in blocks]
        images = []
        for index, box in enumerate(figures, 1):
            filename = f'wqv2-es-{number:02}-{index:02}.png'
            pixels = page.get_pixmap(matrix=fitz.Matrix(600/72, 600/72), clip=box, alpha=False)
            pixels.save(assets/filename)
            images.append(dict(box=box, kind='figure', file=filename, width=pixels.width, height=pixels.height))
        lines = shared.lines_for(data, page)
        body.append(f'<section class="source-page" id="page-{number}" data-page="{number}"><p class="page-label">Página PDF {number}</p>')
        for panel in data['panels']:
            panel_index = panel['panel']
            booklet = (number-1)*4+panel_index+1
            label = f'S-{booklet}' if booklet < 44 else 'Anexo'
            body.append(f'<div class="booklet-panel" id="booklet-{booklet}"><p class="page-label">{label}</p>')
            if str(panel_index) in entry.get('panelHTML', {}):
                body.append(entry['panelHTML'][str(panel_index)])
                body.append('</div>')
                continue
            rect = fitz.Rect(panel['rect'])
            items = []
            for line in lines:
                if line['panel'] != panel_index or line['box'].y0 >= entry['footerY'][panel_index]:
                    continue
                if any(shared.base.overlap(line['box'], b['box']) > .9*line['box'].get_area() for b in blocks):
                    continue
                text = shared.text_for(line, masks, data, page)
                text = entry['corrections'].get(line['id'], text)
                text = clean(text)
                if not text or re.fullmatch(r'(?:[Ss5]-?\s*\d+|[|_©®@*•\s]+)', text):
                    continue
                items.append({**line, 'kind': 'text', 'text': text})
            items.extend(image for image in images if rect.contains((image['box'].tl+image['box'].br)/2))
            items.extend(block for block in blocks if rect.contains((block['box'].tl+block['box'].br)/2))
            items.sort(key=lambda item: (item['box'].y1 if item['kind']=='text' else item['box'].y0,
                                         0 if item['kind']=='figure' else 1, item['box'].x0))
            normal = shared.base.median([item['size'] for item in items if item['kind']=='text' and len(item['text'])>25] or [6])
            for image in [item for item in items if item['kind']=='figure']:
                at = items.index(image)
                # A heading beside a watch drawing is read before the picture.
                if at+1 < len(items) and items[at+1].get('text') in entry['headings'] and abs(items[at+1]['box'].y0-image['box'].y0) < normal*4:
                    items.pop(at)
                    items.insert(at+1, image)
                    at += 1
                if at and at+1 < len(items) and items[at-1]['kind']==items[at+1]['kind']=='text':
                    before, after = items[at-1], items[at+1]
                    continuation = after['text'][:1].islower() and not re.search(r'[.!?:;]$', before['text'])
                    if before['text'] not in entry['headings'] and (before['paragraph'] == after['paragraph'] or continuation):
                        first = at-1
                        while first:
                            current, earlier = items[first], items[first-1]
                            if earlier['kind'] != 'text' or earlier['text'] in entry['headings']:
                                break
                            continuation = current['text'][:1].islower() and not re.search(r'[.!?:;]$', earlier['text'])
                            if earlier['paragraph'] != current.get('paragraph') and not continuation:
                                break
                            first -= 1
                        items.pop(at)
                        items.insert(first, image)
            paragraph, previous = [], None
            def flush():
                if paragraph:
                    body.append('<p>'+html.escape(paragraph_text(paragraph))+'</p>')
                    paragraph.clear()
            for index, item in enumerate(items):
                if item['kind']=='block':
                    flush()
                    markup = item['html']
                    if markup.startswith('<table'):
                        markup = '<div class="manual-table-wrap" tabindex="0" role="region" aria-label="Tabla">'+markup+'</div>'
                    body.append(markup)
                    previous = None
                    continue
                if item['kind']=='figure':
                    flush()
                    box = item['box']
                    floating = (' float-left' if box.x0-rect.x0 < rect.width*.45 else ' float-right') if box.width < rect.width*.45 else ''
                    width, height = box.width*16/max(normal, 5), box.height*16/max(normal, 5)
                    cleanup = shared.crop_masks(item, entry.get('cropMasks', {}).get(str(images.index(item)+1), []))
                    body.append(f'<figure class="illustration{floating}"><div class="diagram-viewport" tabindex="0" role="region" aria-label="Ilustración"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ilustración original" viewBox="0 0 {item["width"]} {item["height"]}" width="{width:.2f}" height="{height:.2f}"><image href="assets/{item["file"]}" width="{item["width"]}" height="{item["height"]}"/>{cleanup}</svg></div></figure>')
                    previous = None
                    continue
                text = item['text']
                if text in entry['headings']:
                    flush()
                    anchor = f'section-{number}-{panel_index}-{index}'
                    body.append(f'<h2 id="{anchor}">{html.escape(text)}</h2>')
                    headings.append(dict(id=anchor, text=text))
                    previous = None
                    continue
                ended = previous and re.search(r'[.!?:;]$', previous['text'])
                separate = previous and (item['box'].y0-previous['box'].y1 > normal*(.85 if ended else 2)
                    or (previous['paragraph'] != item['paragraph'] and ended))
                if separate or re.match(r'^(?:•|\d+[.)]\s)', text):
                    flush()
                paragraph.append(text)
                previous = item
            flush()
            body.append('</div>')
        body.append('</section>')
        figure_count += len(figures)
    title = 'WQV-1/2 — Guía del usuario'
    markup = '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><link rel="stylesheet" href="document.css"></head><body><article data-pages="11"><h1>'+title+'</h1><p class="source-note">Texto reconocido y cotejado con el original escaneado. Las ilustraciones proceden del original.</p>'+''.join(body)+f'<footer><a href="{review["sourceURL"]}" target="_blank" rel="noopener">PDF original</a> · CASIO COMPUTER CO., LTD.</footer></article></body></html>\n'
    # Explicit index blocks contribute headings too.
    markup, headings = shared.base.reviewed_headings(markup, 'es')
    (output/'wqv2-es.html').write_text(markup)
    manifest_path = output/'manifest.json'
    catalog = {entry['id']: entry for entry in json.loads(manifest_path.read_text())}
    catalog['wqv2-es'] = dict(id='wqv2-es', model='WQV-1/2', language='es', module=2220,
        title=title, pages=11, file='wqv2-es.html', sourceURL=review['sourceURL'],
        sourceSHA256=review['sourceSHA256'], scanned=True, illustrations=figure_count, headings=headings)
    manifest_path.write_text(json.dumps(list(catalog.values()), ensure_ascii=False, indent=2)+'\n')
    print('wqv2-es: 11 pages,', figure_count, 'illustrations')


if __name__ == '__main__':
    build()
