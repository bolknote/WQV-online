#!/usr/bin/env python3
"""Build German guides from independently recognized, page-reviewed scan panels.

Source PDFs and Tesseract/Vision caches stay in research/manuals. Only reviewed
text and original illustration crops are published. --draft allows review of
new pages; a normal build refuses pages which have not been signed off.
"""
from pathlib import Path
import argparse, collections, hashlib, html, importlib.util, json, re
import pymupdf as fitz

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('manual_builder',ROOT/'scripts/build-manuals.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
MODELS={'wqv2':2220,'wqv10':2412}
REVIEW=ROOT/'docs/manuals/german-proofreading.json'

def lines_for(data,page):
    groups=collections.defaultdict(list)
    for word in data['words']:
        groups[(word['panel'],word['block_num'],word['par_num'],word['line_num'])].append(word)
    sx=page.rect.width/data['width'];sy=page.rect.height/data['height']
    lines=[]
    for key,words in groups.items():
        words=sorted(words,key=lambda w:w['left'])
        box=fitz.Rect(min(w['left'] for w in words)*sx,min(w['top'] for w in words)*sy,
            max(w['left']+w['width'] for w in words)*sx,max(w['top']+w['height'] for w in words)*sy)
        lines.append(dict(id=':'.join(map(str,key)),panel=key[0],paragraph=key[:3],box=box,words=words,
                          size=base.median(w['height']*sy for w in words),text=' '.join(w['text'] for w in words)))
    return lines

def text_for(line,figures,data,page):
    sx=page.rect.width/data['width'];sy=page.rect.height/data['height']
    words=[]
    for w in line['words']:
        box=fitz.Rect(w['left']*sx,w['top']*sy,(w['left']+w['width'])*sx,(w['top']+w['height'])*sy)
        if any(base.overlap(box,f)>.60*box.get_area() for f in figures):continue
        words.append(w['text'])
    text=' '.join(words).strip()
    text=re.sub(r'^[*«»]\s*','• ',text)
    text=re.sub(r'\s+[|_]$','',text)
    return text

def paragraph_text(parts):
    out=''
    for text in parts:
        if out.endswith('-'):
            # An Ergänzungsstrich belongs to the preceding word: "ein- oder",
            # "Stunden- und" and "BMP- oder" are not split compound words.
            if re.match(r'^(?:und\b|oder\b|bzw\.(?:\s|$))',text):out+=' '+text
            elif text[:1].islower() and not re.search(r'\b[A-ZÄÖÜ]{2,}-$',out):out=out[:-1]+text
            else:out+=text
        else:out+=(' ' if out else '')+text
    return out

def crop_masks(figure,masks):
    """Remove incidental prose at a crop edge, already retained as HTML."""
    box=figure['box'];sx=figure['width']/box.width;sy=figure['height']/box.height;parts=[]
    for mask in masks:
        area=fitz.Rect(mask)
        assert box.contains(area),'Crop cleanup lies outside illustration'
        parts.append(f'<rect x="{(area.x0-box.x0)*sx:.2f}" y="{(area.y0-box.y0)*sy:.2f}" width="{area.width*sx:.2f}" height="{area.height*sy:.2f}" fill="white"/>')
    return ''.join(parts)

def restored_labels(figure,repairs):
    """Typeset complete labels over text clipped in the original scan.

    Keep scan pixels, watches and leader lines intact; only the recorded label
    rectangles are covered. Coordinates refer to the unchanged source PDF.
    """
    box=figure['box'];sx=figure['width']/box.width;sy=figure['height']/box.height;parts=[]
    for repair in repairs:
        area=fitz.Rect(repair['box'])
        assert box.contains(area),'Restored label lies outside illustration'
        x=(area.x0-box.x0)*sx;y=(area.y0-box.y0)*sy;w=area.width*sx;h=area.height*sy
        size=repair.get('fontSize',6.5)*sy
        parts.append(f'<g class="reconstructed-label"><rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" fill="white"/>')
        if repair.get('circleLetter'):
            cx=x+w/2;cy=y+h/2;rx=min(w/2-1*sx,3.9*sx);ry=min(h/2-.6*sy,3.9*sy)
            parts.append(f'<ellipse cx="{cx:.2f}" cy="{cy:.2f}" rx="{rx:.2f}" ry="{ry:.2f}" fill="none" stroke="#111" stroke-width="{.35*sx:.2f}"/>')
            parts.append(f'<text x="{cx:.2f}" y="{cy+size*.35:.2f}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="{size:.2f}" fill="#111">{html.escape(repair["circleLetter"])}</text>')
        else:
            weight='700' if repair.get('bold') else '400';style='italic' if repair.get('italic') else 'normal'
            for index,line in enumerate(repair['lines']):
                baseline=y+size+index*repair.get('lineHeight',repair.get('fontSize',6.5)*1.2)*sy
                parts.append(f'<text x="{x+.2*sx:.2f}" y="{baseline:.2f}" font-family="Arial,Helvetica,sans-serif" font-size="{size:.2f}" font-weight="{weight}" font-style="{style}" fill="#111">{html.escape(line)}</text>')
        parts.append('</g>')
    return ''.join(parts)

def build(model,review,draft):
    identifier=model+'-de';module=MODELS[model]
    source=ROOT/'research/manuals/sources'/(identifier+'.pdf');doc=fitz.open(source)
    record=review.setdefault(identifier,{'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'pages':{}})
    assert record['sourceSHA256']==hashlib.sha256(source.read_bytes()).hexdigest(),'Source PDF changed'
    output=ROOT/'dist/manuals';assets=output/'assets';assets.mkdir(exist_ok=True)
    body=[];headings=[];report=[];allfigures=0
    for number,page in enumerate(doc,1):
        if model=='wqv2' and number==4:
            supplement=(ROOT/'docs/manuals/wqv2-de-supplement.html').read_text()
            body.append(supplement);allfigures+=4
            for level,anchor,text in re.findall(r'<(h[23]) id="([^"]+)">([^<]+)</h[23]>',supplement):
                headings.append(dict(id=anchor,text=html.unescape(text)))
        cache=ROOT/'research/manuals/ocr'/identifier/f'page-{number:02}.json';data=json.loads(cache.read_text())
        entry=record['pages'].get(str(number))
        if entry is None:
            # Proposed rectangles are reviewed visually before a final build.
            figures=base.scanned_figures(cache,page,data)
            entry={'reviewed':False,'figures':[list(f) for f in figures],'corrections':{},'headings':[], 'clippedLines':[], 'notes':[]}
            record['pages'][str(number)]=entry
        if not draft and not entry.get('reviewed'):raise ValueError(f'{identifier}: page {number} is not reviewed')
        figures=[fitz.Rect(f) for f in entry['figures']]
        blocks=[dict(box=fitz.Rect(b['rect']),kind='block',html=b['html']) for b in entry.get('blocks',[])]
        masks=figures+[b['box'] for b in blocks]
        lines=lines_for(data,page);body.append(f'<section class="source-page" id="page-{number}" data-page="{number}"><p class="page-label">PDF-Seite {number}</p>')
        # Keep the scan pixels; explicit overlays repair labels missing in the source.
        images=[]
        for i,figure in enumerate(figures):
            name=f'{identifier}-{number:02}-{i+1:02}.png'
            pix=page.get_pixmap(matrix=fitz.Matrix(600/72,600/72),clip=figure,alpha=False);pix.save(assets/name)
            images.append(dict(box=figure,kind='figure',file=name,width=pix.width,height=pix.height))
        for panel in data['panels']:
            body.append('<div class="booklet-panel">')
            pindex=panel['panel'];rect=fitz.Rect(panel['rect'])
            subset=[]
            for line in lines:
                if line['panel']!=pindex:continue
                if any(base.overlap(line['box'],b['box'])>.9*line['box'].get_area() for b in blocks):continue
                text=text_for(line,masks,data,page)
                if line['id'] in entry['corrections']:text=entry['corrections'][line['id']]
                if not text or re.fullmatch(r'G\s*[-—]?\s*\d*|[|_©®@*•\s]+',text):continue
                if len(text)<4 and line['box'].y0>rect.y1-30:continue
                subset.append({**line,'text':text,'kind':'text'})
            subset.extend(f for f in images if rect.contains((f['box'].tl+f['box'].br)/2))
            subset.extend(b for b in blocks if rect.contains((b['box'].tl+b['box'].br)/2))
            # Tall OCR boxes sometimes extend above the preceding heading.
            # Baselines preserve the printed order of headings and body lines.
            subset.sort(key=lambda x:(x['box'].y1 if x['kind']=='text' else x['box'].y0,0 if x['kind']=='figure' else 1,x['box'].x0))
            normal=base.median([l['size'] for l in subset if l['kind']=='text' and len(l['text'])>25] or [5])
            # Put a floating illustration before the wrapped paragraph it belongs to.
            for item in [x for x in subset if x['kind']=='figure']:
                at=subset.index(item)
                if at and at+1<len(subset):
                    a,b=subset[at-1],subset[at+1]
                    if a['kind']=='text' and b['kind']=='text' and a['paragraph']==b['paragraph']:
                        first=at-1
                        while first and subset[first-1].get('paragraph')==a['paragraph']:first-=1
                        subset.pop(at);subset.insert(first,item)
            parts=[];paragraph=[];previous=None
            def flush():
                if paragraph:parts.append('<p>'+html.escape(paragraph_text(paragraph))+'</p>');paragraph.clear()
            for index,item in enumerate(subset):
                if item['kind']=='block':
                    flush();blockHTML=item['html']
                    if blockHTML.startswith('<table'):
                        columns=len(re.findall(r'<th\b',blockHTML.split('</thead>')[0]))
                        wide=' wide-table' if columns>4 else ''
                        blockHTML=f'<div class="manual-table-wrap{wide}" tabindex="0" role="region" aria-label="Tabelle">'+blockHTML+'</div>'
                    parts.append(blockHTML);previous=None;continue
                if item['kind']=='figure':
                    flush();f=item['box'];relative=f.x0-rect.x0
                    floating=(' float-left' if relative<rect.width*.45 else ' float-right') if f.width<rect.width*.45 else ''
                    w=f.width*16/max(normal,5);h=f.height*16/max(normal,5)
                    figureID=str(images.index(item)+1)
                    caption=entry.get('captions',{}).get(figureID)
                    captionHTML='<figcaption>'+html.escape(caption)+'</figcaption>' if caption else ''
                    repairs=entry.get('labelRepairs',{}).get(figureID,[])
                    restored=crop_masks(item,entry.get('cropMasks',{}).get(figureID,[]))+restored_labels(item,repairs)
                    extra=' restored-figure' if repairs else ''
                    labelNote='<span class="illustration-repair-note">Beschriftung ergänzt</span>' if repairs else ''
                    imageLabel='Abbildung mit ergänzter Beschriftung' if repairs else 'Originalabbildung'
                    parts.append(f'<figure class="illustration{floating}{extra}" data-figure="{number}-{figureID}">{labelNote}<div class="diagram-viewport" tabindex="0" role="region" aria-label="Abbildung"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{imageLabel}" viewBox="0 0 {item["width"]} {item["height"]}" width="{w:.2f}" height="{h:.2f}"><image href="assets/{item["file"]}" width="{item["width"]}" height="{item["height"]}"/>{restored}</svg></div>{captionHTML}</figure>');previous=None;continue
                text=item['text'];forced=text in entry.get('headings',[])
                # Scan glyph heights vary wildly (especially circled buttons).
                # Only headings identified during proofreading enter the contents.
                heading=forced
                if heading:
                    flush();anchor=f'section-{number}-{pindex}-{index}';parts.append(f'<h2 id="{anchor}">{html.escape(text)}</h2>');headings.append(dict(id=anchor,text=text));previous=None;continue
                # OCR often gives each wrapped line a separate paragraph ID.
                # Keep a continuing sentence together, including across blocks.
                sentenceEnd=previous and re.search(r'[.!?:;]$',previous['text'])
                new=previous and (item['box'].y0-previous['box'].y1>normal*(.85 if sentenceEnd else 2) or
                    (previous['paragraph']!=item['paragraph'] and sentenceEnd))
                if new or item['id'] in entry.get('paragraphStarts',[]) or re.match(r'^(?:[•●]|(?:\d+[.)]|\(\d+\))\s|(?:I|II|III|IV|V)\s|[A-ZÄÖÜ][a-zäöüß-]*(?: [a-zäöüß-]+){0,3}:)',text):flush()
                paragraph.append(text)
                if re.search(r' — G(?:-\d+)?$',text):flush()
                if item['id'] in entry.get('clippedLines',[]):
                    flush();parts.append('<p class="source-note">[Text am Rand des Originalscans abgeschnitten.]</p>')
                previous=item
            flush();body.extend(parts);body.append('</div>')
        body.append('</section>');allfigures+=len(figures)
        report.append(dict(page=number,lines=[dict(id=l['id'],text=entry['corrections'].get(l['id'],text_for(l,masks,data,page)),ocrText=text_for(l,masks,data,page),box=list(l['box'])) for l in lines]))
    title=model.upper().replace('WQV','WQV-')+' — Bedienungsanleitung'
    url=f'https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/{str(module)[:2]}/{module}/qw{module}_DE.pdf'
    note='Arbeitsfassung: noch nicht vollständig geprüft.' if draft else 'Aus dem deutschen Originalscan übertragen und seitenweise geprüft. Die Abbildungen stammen unverändert aus dem Original.'
    if any(p.get('labelRepairs') for p in record['pages'].values()):
        note=note.replace('Die Abbildungen stammen unverändert aus dem Original.','Die Abbildungen stammen aus dem Original; angeschnittene Beschriftungen wurden ergänzt.')
    if any(p.get('clippedLines') for p in record['pages'].values()):note+=' Im Original abgeschnittene Textstellen sind ausdrücklich gekennzeichnet.'
    content=f'<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><link rel="stylesheet" href="document.css"></head><body><article data-pages="{len(doc)}"><h1>{title}</h1><p class="source-note">{note}</p>'+''.join(body)+f'<footer><a href="{url}" target="_blank" rel="noopener">Original-PDF</a> · CASIO COMPUTER CO., LTD.</footer></article></body></html>\n'
    (output/(identifier+'.html')).write_text(content)
    (ROOT/'research/manuals/qa'/(identifier+'-lines.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    if model=='wqv2':
        original=ROOT/'research/manuals/sources/wqv2-en.pdf'
        assert hashlib.sha256(original.read_bytes()).hexdigest()==record['supplementSource']['sha256']
        english=fitz.open(original)[2]
        for name,box in {'brightness':(78,207,151,300),'lighting':(57,504,303,582),'modes':(366,157,600,239),'merge':(376,286,445,381)}.items():
            english.get_pixmap(matrix=fitz.Matrix(6,6),clip=fitz.Rect(box),alpha=False).save(assets/f'wqv2-de-supplement-{name}.png')
    return dict(id=identifier,model=model.upper().replace('WQV','WQV-'),language='de',module=module,title=title,pages=len(doc),file=identifier+'.html',sourceURL=url,sourceSHA256=record['sourceSHA256'],scanned=True,illustrations=allfigures,headings=headings,
                **({'supplement':record['supplementSource'],'missingOriginalPages':record['missingOriginalPages']} if model=='wqv2' else {}))

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--draft',action='store_true');parser.add_argument('--only',nargs='+',choices=MODELS);args=parser.parse_args()
    review=json.loads(REVIEW.read_text()) if REVIEW.exists() else {}
    catalogpath=ROOT/'dist/manuals/manifest.json';catalog=json.loads(catalogpath.read_text());entries={e['id']:e for e in catalog}
    for model in args.only or MODELS:
        entry=build(model,review,args.draft);entries[entry['id']]=entry;print(entry['id'],entry['pages'],'pages',entry['illustrations'],'illustrations',flush=True)
    REVIEW.write_text(json.dumps(review,ensure_ascii=False,indent=2)+'\n');catalogpath.write_text(json.dumps(list(entries.values()),ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
