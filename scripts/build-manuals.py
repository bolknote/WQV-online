#!/usr/bin/env python3
"""Build reflowable HTML manuals and original vector illustrations.

Requires PyMuPDF 2.0 and ImageMagick. Japanese word-coordinate OCR caches are
produced by research/manuals/ocr.py from the unmodified source PDFs.
Source PDFs are never overwritten. HTML contains real text, not page pictures.
"""
import argparse
import base64
from collections import defaultdict
from pathlib import Path
from statistics import median
import hashlib
import html
import json
import re
import subprocess
import xml.etree.ElementTree as ET
import pymupdf as fitz

REPO = Path(__file__).resolve().parents[1]
LANG = {
    'en': dict(title='User’s Guide', page='Page', illustration='Illustration', source='Original PDF',
               ocr='Japanese text was recognized from a scan. Illustrations are taken from the original.'),
    'ru': dict(title='Руководство пользователя', page='Страница', illustration='Иллюстрация', source='Исходный PDF',
               ocr='Японский текст распознан со скана. Иллюстрации взяты из оригинала.'),
    'ja': dict(title='取扱説明書', page='ページ', illustration='図', source='原本PDF',
               ocr='本文はスキャンから文字認識したものです。図は原本から抽出しています。'),
}
SOURCES = {
    'wqv2-en': 'https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_EN.pdf',
    'wqv2-ru': 'https://i-watch.ru/image/catalog/info/instruktsii/casio/2220.pdf',
    'wqv2-ja': 'https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_JA.pdf',
    'wqv3-en': 'https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_EN.pdf',
    'wqv3-ru': 'https://i-watch.ru/image/catalog/info/instruktsii/casio/2411.pdf',
    'wqv3-ja': 'https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_JA.pdf',
}
FIGURE_BOUNDS = json.loads((REPO/'docs/manuals/figure-bounds.json').read_text())

def escaped(value):
    return html.escape(str(value), quote=True)

def overlap(a, b):
    return (a & b).get_area()

def merge_boxes(boxes, tolerance=0):
    result = []
    for box in boxes:
        box = fitz.Rect(box)
        changed = True
        while changed:
            changed = False
            for i, other in enumerate(result):
                if (box + (-tolerance, -tolerance, tolerance, tolerance)).intersects(other):
                    box |= result.pop(i)
                    changed = True
                    break
        result.append(box)
    return result

def native_lines(page):
    lines = []
    for block in page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']:
        if block['type']:
            continue
        for line in block['lines']:
            spans = line['spans']
            text = ''.join(s['text'] for s in spans).strip()
            if not text:
                continue
            lines.append(dict(box=fitz.Rect(line['bbox']), text=text, paragraph=block['number'],
                              size=max(s['size'] for s in spans),
                              bold=all(s['flags'] & 16 for s in spans if s['text'].strip()),
                              italic=all(s['flags'] & 2 for s in spans if s['text'].strip())))
    return lines

def ocr_lines(data, page):
    sx, sy = page.rect.width / data['width'], page.rect.height / data['height']
    groups = defaultdict(list)
    for word in data['words']:
        groups[(word['block_num'], word['par_num'], word['line_num'])].append(word)
    lines = []
    for (block, paragraph, _), words in groups.items():
        words.sort(key=lambda w: w['left'])
        left, top = min(w['left'] for w in words), min(w['top'] for w in words)
        right = max(w['left'] + w['width'] for w in words)
        bottom = max(w['top'] + w['height'] for w in words)
        text = ''
        for word in words:
            part = word['text']
            if text and re.search(r'[A-Za-z0-9]$', text) and re.match(r'[A-Za-z0-9]', part):
                text += ' '
            text += part
        text=re.sub(r'^m→', '⇒', text)
        # Corrections checked against the original WQV-3 communication page.
        text=re.sub(r'^通機能は', '通信機能は', text)
        text=re.sub(r'(?<!信)通できる距離', '通信できる距離', text)
        lines.append(dict(box=fitz.Rect(left*sx, top*sy, right*sx, bottom*sy), text=text,
                          size=median(w['height']*sy for w in words), bold=False, italic=False,
                          paragraph=(block, paragraph)))
    return lines

def scanned_figures(cache, page, data):
    """Find non-text ink, retaining captions by cropping the untouched PDF later."""
    report = cache.with_suffix('.components.txt')
    if not report.exists():
        draw = ' '.join(f"rectangle {w['left']-2},{w['top']-2} "
                        f"{w['left']+w['width']+2},{w['top']+w['height']+2}" for w in data['words'])
        result = subprocess.run(['magick', str(cache.with_suffix('.png')), '-alpha', 'off',
            '-colorspace', 'Gray', '-threshold', '65%', '-negate', '-fill', 'black',
            '-draw', draw or 'point 0,0', '-morphology', 'Close', 'Disk:2',
            '-define', 'connected-components:verbose=true', '-connected-components', '8', 'null:'],
            capture_output=True, text=True, check=True)
        report.write_text(result.stdout)
    sx, sy = page.rect.width / data['width'], page.rect.height / data['height']
    boxes = []
    for line in report.read_text().splitlines():
        match = re.search(r'\d+: (\d+)x(\d+)\+(\d+)\+(\d+) [\d.,]+ ([\d.e+]+) gray(?:a)?\((\d+)(?:,[^)]*)?\)', line)
        if not match:
            continue
        width, height, x, y = map(int, match.groups()[:4])
        area, white = float(match[5]), int(match[6])
        if white != 255 or width < 24 or height < 18 or area < 100:
            continue
        if width > data['width']*.8 or height > data['height']*.7:
            continue
        if y < data['height']*.075 and height < data['height']*.09:
            continue
        boxes.append(fitz.Rect((x-30)*sx, (y-30)*sy, (x+width+30)*sx, (y+height+30)*sy) & page.rect)
    return merge_boxes(boxes, tolerance=3)

def reviewed_scan_figures(identifier, number, page):
    """Source-checked bounds for compound drawings with faint, missed labels."""
    review = FIGURE_BOUNDS.get(identifier, {}).get(str(number))
    if not review:
        return None
    sx, sy = page.rect.width/review['width'], page.rect.height/review['height']
    return [fitz.Rect(x0*sx, y0*sy, x1*sx, y1*sy)
            for x0,y0,x1,y1 in review['figures']]

def native_figures(page):
    paths = []
    for drawing in page.get_drawings():
        box = drawing['rect']
        # Page borders, paragraph panels and heading rules are presentation,
        # not illustrations. Do not carry them into the reflowable document.
        simple = all(item[0] in ('re', 'qu', 'l') for item in drawing['items'])
        if simple and box.width > page.rect.width*.31:
            continue
        if box.get_area() > page.rect.get_area()*.65:
            continue
        paths.append(drawing)
    boxes = [box for box in page.cluster_drawings(drawings=paths)
             if box.width > 4 and box.height > 2]
    images = [fitz.Rect(image['bbox']) for image in page.get_image_info()
              if fitz.Rect(image['bbox']).get_area() < page.rect.get_area()*.8]
    boxes.extend(images)
    # Whole diagrams (for example stopwatch sequences) must stay together.
    page.get_layout()
    for x0, y0, x1, y1, kind in page.layout_information:
        box = fitz.Rect(x0,y0,x1,y1)
        if kind in ('picture', 'table') and box.width > 20 and box.height > 12:
            if box.get_area() < page.rect.get_area()*.4 and any(overlap(box, part) > 0 for part in boxes):
                boxes.append(box)
    return merge_boxes([(box + (-2,-2,2,2)) & page.rect for box in boxes]), len(images)

def picture_line(line, figures):
    return any(overlap(line['box'], box) >= line['box'].get_area()*.94 for box in figures)

def flow_items(lines, figures, page):
    body = [line for line in lines if not picture_line(line, figures)]
    # Avoid page numbers and the old running header becoming huge headings.
    for line in body:
        line['kind'] = 'text'
        if re.fullmatch(r'(?:2220|2411)-\d+', line['text']) or (
                re.fullmatch(r'\d+', line['text']) and line['box'].y0 > page.rect.height*.92):
            line['kind'] = 'page-number'
    sizes = [line['size'] for line in body if len(line['text']) > 20]
    normal = median(sizes) if sizes else 9
    for line in body:
        if len(line['text'])<10 and line['box'].y0>page.rect.height*.94:
            line['kind']='page-number'
        if line['box'].y0<page.rect.height*.075 and line['size']<normal*.85:
            line['kind']='page-number'
    items = [dict(box=box, kind='figure') for box in figures] + body
    middle = page.rect.width/2
    regular = [line for line in body if line['kind'] != 'page-number']
    left = sum(line['box'].x1 < middle+5 for line in regular)
    right = sum(line['box'].x0 > middle-5 for line in regular)
    columns = left > 5 and right > 5 and (left+right) > len(regular)*.72
    wide = [item for item in items if item['box'].width > page.rect.width*.62]
    wide.sort(key=lambda item: item['box'].y0)
    ordered, remaining = [], [item for item in items if not any(item is w for w in wide)]
    for boundary in [*wide, None]:
        edge = boundary['box'].y0 if boundary else float('inf')
        band = [item for item in remaining if item['box'].y0 < edge]
        remaining = [item for item in remaining if item['box'].y0 >= edge]
        band.sort(key=lambda item: ((int((item['box'].x0+item['box'].x1)/2 >= middle) if columns else 0),
                                    item['box'].y0, 0 if item['kind']=='figure' else 1, item['box'].x0))
        ordered.extend(band)
        if boundary:
            ordered.append(boundary)
    # A drawing beside a wrapped paragraph belongs before that paragraph,
    # rather than between two halves of the same sentence.
    for figure in [item for item in ordered if item['kind']=='figure']:
        position=ordered.index(figure)
        before=ordered[position-1] if position else None
        after=ordered[position+1] if position+1<len(ordered) else None
        if before and after and before['kind']=='text' and after['kind']=='text' and before['paragraph']==after['paragraph']:
            first=position-1
            while first and ordered[first-1]['kind']=='text' and ordered[first-1]['paragraph']==before['paragraph']:
                first-=1
            ordered.pop(position);ordered.insert(first,figure)
    return ordered, normal, columns

def render_flow(items, normal, columns, page, number, svgfile, language, raster=None):
    parts, paragraph, previous = [], [], None
    texts = LANG[language]
    def flush():
        nonlocal paragraph
        if paragraph:
            text = ('' if language == 'ja' else ' ').join(paragraph).replace('\u00ad','')
            parts.append('<p>'+text+'</p>')
            paragraph = []
    headings = []
    for index, item in enumerate(items):
        box = item['box']
        if item['kind'] == 'figure':
            flush()
            width = box.width * 16/max(normal,5)
            height = box.height * 16/max(normal,5)
            colwidth = page.rect.width/(2 if columns else 1)
            relative_x = box.x0 % (page.rect.width/2) if columns else box.x0
            floating = (' float-left' if relative_x < colwidth*.45 else ' float-right') if box.width < colwidth*.40 else ''
            viewbox = ' '.join(f'{v:.3f}' for v in [box.x0,box.y0,box.width,box.height])
            if raster:
                transform=' '.join(f'{v:.7f}' for v in raster['transform'])
                picture=f'<image href="assets/{raster["file"]}" width="1" height="1" preserveAspectRatio="none" transform="matrix({transform})"/>'
            else:
                picture=f'<use href="assets/{svgfile}#page"/>'
            parts.append(f'<figure class="illustration{floating}"><svg xmlns="http://www.w3.org/2000/svg" '
                         f'role="img" aria-label="{texts["illustration"]}" viewBox="{viewbox}" '
                         f'width="{width:.2f}" height="{height:.2f}">'
                         f'{picture}</svg></figure>')
            previous = None
            continue
        if item['kind'] == 'page-number':
            continue
        text = escaped(item['text'])
        heading = item['size'] > normal*1.23 and len(item['text']) < 130
        minor = item['bold'] and len(item['text']) < 100
        new = previous and (previous['paragraph'] != item['paragraph'] or box.y0 - previous['box'].y1 > normal*.85)
        listed = bool(re.match(r'^(?:[•●・※]|\d+[.)．、])', item['text']))
        if heading or minor:
            flush()
            level = 'h2' if heading else 'h3'
            anchor = f'section-{number}-{index}'
            parts.append(f'<{level} id="{anchor}">{text}</{level}>')
            if heading:
                headings.append({'id':anchor,'text':item['text']})
        else:
            if new or listed:
                flush()
            if item['bold']:
                text = '<strong>'+text+'</strong>'
            if item['italic']:
                text = '<em>'+text+'</em>'
            paragraph.append(text)
        previous = item
    flush()
    return '\n'.join(parts), headings

def build(identifier, source, ocrroot, output):
    model, language = identifier.split('-')
    directory = output/'assets'
    directory.mkdir(parents=True,exist_ok=True)
    doc = fitz.open(source)
    sections, allheadings, report = [], [], []
    for n, page in enumerate(doc,1):
        if language == 'ja':
            # OCR was made from the complete MediaBox, including a book spread.
            page.set_cropbox(page.mediabox)
        if page.rotation:
            page.remove_rotation()
        if language == 'ja':
            cache = ocrroot/identifier/f'page-{n:02}.json'
            data = json.loads(cache.read_text())
            lines = ocr_lines(data,page)
            figures = reviewed_scan_figures(identifier,n,page)
            if figures is None:
                figures = scanned_figures(cache,page,data)
            raster_count = len(page.get_image_info())
        else:
            lines = native_lines(page)
            figures,raster_count = native_figures(page)
        raster=None
        if language=='ja' and len(page.get_image_info())==1:
            # Keep scan pixels in binary PNG files. Large Base64 strings in SVG
            # can accidentally match credential patterns in repository scanners.
            # Decoding the PNG from MuPDF's SVG is lossless: no resampling.
            tree=ET.fromstring(page.get_svg_image(text_as_path=True))
            embedded=[value for element in tree.iter() for value in element.attrib.values()
                      if value.startswith('data:image/png;base64,')]
            if len(embedded)==1:
                imagefile=f'{identifier}-{n:02}.png'
                pixels=base64.b64decode(embedded[0].partition(',')[2])
                assert pixels.startswith(b'\x89PNG\r\n\x1a\n')
                (directory/imagefile).write_bytes(pixels)
                raster={'file':imagefile,'transform':page.get_image_info()[0]['transform']}
                previous=directory/f'{identifier}-{n:02}.svg'
                if previous.exists():previous.unlink()
        items,normal,columns = flow_items(lines,figures,page)
        body,headings = render_flow(items,normal,columns,page,n,f'{identifier}-{n:02}.svg',language,raster)
        allheadings.extend(headings)
        if language != 'ja':
            for line in lines:
                if not picture_line(line,figures):
                    page.add_redact_annot(line['box'],fill=None,cross_out=False)
            # Remove only the text already represented in HTML. Keep images,
            # line art and the original lettering inside the illustrations.
            page.apply_redactions(images=0,graphics=0,text=0)
        if not raster:
            svg = page.get_svg_image(text_as_path=True)
            svg = svg.replace('<svg ', '<svg id="page" ',1)
            (directory/f'{identifier}-{n:02}.svg').write_text(svg)
        label = f'{LANG[language]["page"]} {n}' if language!='ja' else f'{n}ページ'
        sections.append(f'<section class="source-page" id="page-{n}" data-page="{n}">'
                        f'<p class="page-label">{label}</p>\n{body}\n</section>')
        report.append(dict(page=n,lines=len(lines),figures=len(figures),rasterImages=raster_count,
                           columns=2 if columns else 1,
                           figureBoxes=[list(box) for box in figures]))
    title = model.upper().replace('WQV','WQV-')+' — '+LANG[language]['title']
    note = '<p class="source-note">'+LANG[language]['ocr']+'</p>' if language=='ja' else ''
    markup = f'''<!doctype html>
<html lang="{language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escaped(title)}</title><link rel="stylesheet" href="document.css"></head><body>
<article data-pages="{len(doc)}"><h1>{escaped(title)}</h1>{note}
{''.join(sections)}
<footer><a href="{SOURCES[identifier]}" target="_blank" rel="noopener">{LANG[language]['source']}</a> · CASIO COMPUTER CO., LTD.</footer>
</article></body></html>'''
    (output/(identifier+'.html')).write_text(markup)
    entry = dict(id=identifier,model=model.upper().replace('WQV','WQV-'),language=language,
                 module=2220 if model=='wqv2' else 2411,title=title,pages=len(doc),
                 file=identifier+'.html',sourceURL=SOURCES[identifier],
                 sourceSHA256=hashlib.sha256(source.read_bytes()).hexdigest(),
                 scanned=language=='ja',illustrations=sum(p['figures'] for p in report),headings=allheadings)
    print(identifier,entry['pages'],'pages',entry['illustrations'],'illustrations',flush=True)
    return entry,report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources',type=Path,default=REPO/'research/manuals/sources')
    parser.add_argument('--ocr',type=Path,default=REPO/'research/manuals/ocr')
    parser.add_argument('--output',type=Path,default=REPO/'dist/manuals')
    parser.add_argument('--only',nargs='*',choices=list(SOURCES))
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    oldmanifest=args.output/'manifest.json'
    oldreport=REPO/'research/manuals/qa/extraction.json'
    existing={item['id']:item for item in json.loads(oldmanifest.read_text())} if args.only and oldmanifest.exists() else {}
    reports=json.loads(oldreport.read_text()) if args.only and oldreport.exists() else {}
    for identifier in args.only or SOURCES:
        entry,report=build(identifier,args.sources/(identifier+'.pdf'),args.ocr,args.output)
        existing[identifier]=entry;reports[identifier]=report
    manifest=[existing[identifier] for identifier in SOURCES if identifier in existing]
    (args.output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (REPO/'research/manuals/qa/extraction.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':
    main()
