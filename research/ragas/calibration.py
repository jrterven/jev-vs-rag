#!/usr/bin/env python3
"""Technical controls and blind human-rating packets; no model calls or human labels."""
import argparse
import hashlib
import json
from pathlib import Path

METRICS = ("faithfulness", "factual_correctness")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def read_jsonl(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    ids = [row["id"] for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate input/result IDs; do not silently pool repeated records")
    return rows


def write_jsonl(path, rows):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in rows))


def technical_controls(repeats=3):
    if repeats < 1:
        raise ValueError("repeats must be positive")
    facts = "The fictional Vega Observatory opened in 2012. It is located in Oslo."
    prompt = "When did the fictional Vega Observatory open, and where is it located?"
    high, low, half = (0.75, 1.0, "high"), (0.0, 0.25, "low"), (0.3, 0.7, "intermediate")
    cases = [
        ("fully-supported", facts, facts, facts, high, high),
        ("unsupported-facts", facts, "The Vega Observatory opened in 2018. It is located in Bergen.", facts, low, low),
        ("partially-supported", "The fictional Vega Observatory opened in 2012.", facts, facts, half, high),
        ("partial-answer", facts, "The Vega Observatory opened in 2012.", facts, high, (0.5, 0.8, "intermediate")),
        ("supported-paraphrase", facts, "Oslo is home to the Vega Observatory, which began operating in 2012.", facts, high, high),
        ("unrelated-evidence-and-reference", "The fictional Lumen Library opened in 1999 in Rome.", facts, "The fictional Lumen Library opened in 1999 in Rome.", low, low),
        ("one-contradicted-fact", facts, "The Vega Observatory opened in 2012. It is located in Bergen.", facts, half, half),
        ("supported-but-reference-contradicted", facts, facts, "The fictional Vega Observatory opened in 2018. It is located in Bergen.", high, low),
    ]
    rows = []
    for name, context, response, reference, faith, correct in cases:
        for repeat in range(1, repeats + 1):
            rows.append({"id": f"technical-v1:{name}:repeat-{repeat}", "question": prompt, "response": response,
                         "contexts": [context], "reference": reference, "metrics": list(METRICS),
                         "metadata": {"cohort": "technical-controls", "control": name, "questionId": f"technical:{name}",
                                      "repeat": repeat, "synthetic": True, "humanCalibration": False,
                                      "expected": {metric: {"min": bounds[0], "max": bounds[1], "direction": bounds[2]}
                                                   for metric, bounds in zip(METRICS, (faith, correct))}}})
    return rows


RUBRIC = {
    "faithfulness": "Fraction of factual claims in the response supported by the supplied contexts: 0 = none, 0.5 = about half, 1 = all. Do not use outside knowledge. Use not_applicable for a response without factual claims or without contexts.",
    "factual_correctness": "Human answer correctness: judge whether the response answers the question, interpreting the reference in the context of that question (including short Yes/No/entity references). 0 = incorrect, 0.5 = partly correct/incomplete, 1 = fully correct and complete without false additions. Use not_applicable when no valid reference comparison is possible. This existing field maps explicitly to question-aware AnswerAccuracy when that additional evaluation is supplied.",
    "instructions": "Enter a raterId and only ratings you actually make. Null means not rated, never a zero. Fractional values between 0 and 1 are allowed. These judgments are a human comparison, not identical claim decompositions to the automated metric. Record ambiguous evidence in note; use issue for a problem that prevents valid rating. Do not consult method identities or automated scores.",
}


def blind_packet(rows, per_stratum=0, seed="ragas-human-v1"):
    """Public packet has no source IDs, methods, cohorts, expectations, or metric scores."""
    selected, groups = [], {}
    for row in rows:
        meta = row.get("metadata", {})
        if meta.get("synthetic") or meta.get("control") or meta.get("cohort") == "technical-controls":
            continue
        key = (meta.get("cohort", "unspecified"), meta.get("method", "unspecified"), bool(meta.get("unanswerable")))
        groups.setdefault(key, []).append(row)
    for key in sorted(groups):
        # Hash order is reproducible and independent of scores. One answer per question/method/stratum.
        candidates = sorted(groups[key], key=lambda row: fingerprint([seed, row["id"]]))
        seen_questions, chosen = set(), []
        for row in candidates:
            question_id = row.get("metadata", {}).get("questionId", fingerprint(row["question"]))
            if question_id in seen_questions:
                continue
            seen_questions.add(question_id)
            chosen.append(row)
        selected.extend(chosen[:per_stratum] if per_stratum else chosen)
    selected.sort(key=lambda row: fingerprint([seed, "order", row["id"]]))
    public, private = [], []
    for index, row in enumerate(selected, 1):
        item_id = f"H{index:04d}-{fingerprint([seed, row['id']])[:10]}"
        content = {key: row[key] for key in ("question", "response", "contexts", "reference") if key in row}
        digest = fingerprint(content)
        public.append({"itemId": item_id, "contentHash": digest, **content, "raterId": "", "ratings": dict.fromkeys(METRICS), "note": "", "issue": ""})
        private.append({"itemId": item_id, "sourceId": row["id"], "contentHash": digest, "metrics": row.get("metrics", []), "metadata": row.get("metadata", {})})
    mapping = {"schemaVersion": 1, "kind": "private-human-mapping", "inputHash": fingerprint(rows), "seed": seed, "items": private}
    return public, mapping


def packet_html(items):
    # Escaping '<' prevents source excerpts from ending the inert JSON script element.
    data = json.dumps(items, ensure_ascii=False).replace("<", "\\u003c").replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return r'''<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisión ciega de respuestas</title><style>
:root{color-scheme:dark;font:16px/1.55 system-ui;color:#e8edf5;background:#11151c}*{box-sizing:border-box}body{max-width:1100px;margin:0 auto;padding:28px 22px 70px}h1{font-size:26px;letter-spacing:-.7px;margin:0}h2{font-size:18px;margin:0 0 8px}h3{font-size:14px;color:#a8b6cc;margin:0 0 7px}p{margin:8px 0}small,.muted{color:#a8b6cc}header{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:22px}button,select,input,textarea{font:inherit;color:inherit;border:1px solid #3b475c;background:#1b2330;border-radius:7px;padding:9px 12px}button{cursor:pointer;white-space:nowrap}button:hover{background:#2c3a51}button:disabled{opacity:.35;cursor:default}.primary{background:#23497a;border-color:#537cad}.card{background:#181e28;border:1px solid #303b4d;border-radius:10px;padding:20px;margin-bottom:16px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.excerpt{border-left:2px solid #567398;padding:10px 14px;margin:8px 0;background:#131a24}label{display:block;font-size:14px;margin-bottom:6px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}input,textarea,select{width:100%}textarea{min-height:80px;resize:vertical}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.nav{display:flex;justify-content:space-between;align-items:center;margin:20px 0}.status{color:#a1c8ae;font-size:13px}details{margin:12px 0}summary{cursor:pointer;color:#b8c9e0}#progress{min-width:140px;text-align:center}#itemid{font-size:12px;color:#97a8bf}a{color:#aacbf3}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #98c3ff;outline-offset:3px}@media(max-width:650px){header,.grid{display:block}.grid>div{margin-bottom:16px}header .actions{margin-top:15px}.card{padding:15px}}
</style><header><div><h1>Revisión ciega de respuestas</h1><p class="muted">Evalúa una respuesta a la vez usando la evidencia mostrada.</p></div><div class="actions"><button id="download" class="primary">Descargar calificaciones</button><button id="import">Importar avance</button><input id="file" type="file" accept=".jsonl,.json" hidden></div></header>
<section class="card"><div class="grid"><div><label for="rater">Tu identificador de evaluador</label><input id="rater" placeholder="Ej. revisor-1" autocomplete="off"></div><div><p id="completion" aria-live="polite"></p><p id="saved" class="status" aria-live="polite"></p></div></div><details><summary>Cómo calificar</summary><p><b>Fidelidad al contexto:</b> 0 = ninguna afirmación factual está respaldada; 0.5 = aproximadamente la mitad; 1 = todas. No uses conocimiento externo. Marca «No aplica» si no hay afirmaciones factuales o no se proporcionó contexto.</p><p><b>Corrección de la respuesta:</b> considera si responde correctamente la pregunta; interpreta la referencia en ese contexto, aunque sea breve como Yes, No o un nombre. 0 = incorrecta; 0.5 = parcialmente correcta o incompleta; 1 = correcta y completa, sin hechos falsos añadidos. Marca «No aplica» si no hay una referencia válida para comparar.</p><p>Una casilla vacía significa pendiente. Estas calificaciones humanas no son una reproducción exacta de la descomposición automática de afirmaciones. Usa «Problema» cuando no sea posible emitir una valoración válida. Guarda el archivo descargado para entregarlo al coordinador.</p></details></section>
<nav class="nav" aria-label="Respuestas"><button id="previous">← Anterior</button><span id="progress" aria-live="polite"></span><button id="next">Siguiente →</button></nav>
<main id="item"><section class="card"><div id="itemid"></div><h3>Pregunta</h3><pre id="question"></pre></section><section class="card"><h2>Respuesta a evaluar</h2><pre id="response"></pre></section><section class="card"><h2>Contexto disponible</h2><div id="contexts"></div></section><section class="card"><h2>Respuesta de referencia</h2><pre id="reference"></pre></section><section class="card"><div class="grid"><div><label for="faithfulness">Fidelidad al contexto</label><select id="faithfulness"><option value="">Pendiente</option value="0">0 — Sin respaldo</option><option value="0.5">0.5 — Respaldo parcial</option><option value="1">1 — Respaldo completo</option><option value="not_applicable">No aplica</option></select></div><div><label for="factual_correctness">Corrección frente a la referencia</label><select id="factual_correctness"><option value="">Pendiente</option><option value="0">0 — Incorrecta</option><option value="0.5">0.5 — Parcial o incompleta</option><option value="1">1 — Correcta y completa</option><option value="not_applicable">No aplica</option></select></div></div><label for="note">Nota (opcional)</label><textarea id="note"></textarea><label for="issue">Problema que impide calificar (opcional)</label><input id="issue"></section></main>
<script id="packet-data" type="application/json">__PUBLIC_DATA__</script><script>
'use strict';
const original=JSON.parse(document.getElementById('packet-data').textContent),key='blind-ratings-v1:__PACKET_HASH__';
const $=id=>document.getElementById(id),metrics=['faithfulness','factual_correctness'];let rows=structuredClone(original),index=0,rater='';
function merge(values){if(!Array.isArray(values))throw Error('El archivo debe contener registros JSONL.');const map=new Map(values.map(x=>[x.itemId,x]));if(map.size!==values.length||values.some(x=>!original.some(y=>y.itemId===x.itemId&&y.contentHash===x.contentHash)))throw Error('El archivo no corresponde a este paquete.');for(const row of rows){const x=map.get(row.itemId);if(!x)continue;for(const m of metrics){const v=x.ratings?.[m]??null;if(![null,0,0.5,1,'not_applicable'].includes(v))throw Error('Calificación inválida.');}row.ratings=Object.fromEntries(metrics.map(m=>[m,x.ratings?.[m]??null]));row.raterId=String(x.raterId??'');row.note=String(x.note??'');row.issue=String(x.issue??'');}rater=values.find(x=>x.raterId)?.raterId??rater;}
try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved){merge(saved.rows);index=Math.min(saved.index||0,Math.max(0,rows.length-1));rater=saved.rater||rater;}}catch(error){$('saved').textContent='No se pudo restaurar el avance local.';}
function persist(){try{localStorage.setItem(key,JSON.stringify({rows,index,rater}));$('saved').textContent='Avance guardado en este navegador.';}catch(error){$('saved').textContent='El navegador no permite guardar: descarga tu avance.';}const done=rows.filter(x=>metrics.every(m=>x.ratings[m]!==null)).length;$('completion').textContent=done+' de '+rows.length+' respuestas calificadas';}
function capture(){if(!rows.length)return;const row=rows[index];rater=$('rater').value.trim();row.raterId=rater;for(const m of metrics){const v=$(m).value;row.ratings[m]=v===''?null:v==='not_applicable'?v:Number(v);}row.note=$('note').value;row.issue=$('issue').value;persist();}
function show(){if(!rows.length){$('item').hidden=true;$('progress').textContent='Sin respuestas';$('previous').disabled=$('next').disabled=true;persist();return;}const row=rows[index];$('rater').value=rater;$('itemid').textContent=row.itemId;$('question').textContent=row.question;$('response').textContent=row.response;$('reference').textContent=row.reference||'No se proporcionó una referencia.';$('contexts').replaceChildren();if(!row.contexts.length)$('contexts').textContent='No se proporcionó contexto.';row.contexts.forEach(text=>{const div=document.createElement('pre');div.className='excerpt';div.textContent=text;$('contexts').append(div);});for(const m of metrics)$(m).value=row.ratings[m]===null?'':String(row.ratings[m]);$('note').value=row.note;$('issue').value=row.issue;$('progress').textContent=(index+1)+' / '+rows.length;$('previous').disabled=index===0;$('next').disabled=index===rows.length-1;persist();}
for(const id of [...metrics,'note','issue','rater'])$(id).addEventListener('input',capture);
$('previous').onclick=()=>{capture();index=Math.max(0,index-1);show();};$('next').onclick=()=>{capture();index=Math.min(rows.length-1,index+1);show();};
$('download').onclick=()=>{capture();if(rows.some(x=>metrics.some(m=>x.ratings[m]!==null))&&!rater){alert('Escribe tu identificador antes de descargar calificaciones.');$('rater').focus();return;}const exported=rows.map(x=>({...x,raterId:metrics.some(m=>x.ratings[m]!==null)?rater:x.raterId}));const blob=new Blob([exported.map(x=>JSON.stringify(x)).join('\n')+'\n'],{type:'application/x-ndjson'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='calificaciones-'+(rater.replace(/[^a-zA-Z0-9_-]/g,'_')||'avance')+'.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import').onclick=()=>$('file').click();$('file').onchange=async event=>{try{const content=await event.target.files[0].text(),values=content.trim().startsWith('[')?JSON.parse(content):content.split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x));merge(values);show();}catch(error){alert('No se pudo importar: '+error.message);}event.target.value='';};show();
</script></html>'''.replace("__PACKET_HASH__", fingerprint(items)).replace("__PUBLIC_DATA__", data)


def preserve_or_create_ratings(path, public):
    path = Path(path)
    if path.exists():
        existing = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        fields = ("itemId", "contentHash", "question", "response", "contexts", "reference")
        comparable = lambda rows: [{key: row[key] for key in fields if key in row} for row in rows]
        if comparable(existing) != comparable(public):
            raise ValueError("Existing ratings contain different items/content; use a new output directory")
        return "preserved"
    write_jsonl(path, public)
    return "created"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fixture = commands.add_parser("fixtures")
    fixture.add_argument("--output", required=True)
    fixture.add_argument("--repeats", type=int, default=3)
    packet = commands.add_parser("packet")
    packet.add_argument("--input", required=True)
    packet.add_argument("--out-dir", required=True)
    packet.add_argument("--per-stratum", type=int, default=0)
    packet.add_argument("--seed", default="ragas-human-v1")
    args = parser.parse_args()
    if args.command == "fixtures":
        rows = technical_controls(args.repeats)
        write_jsonl(args.output, rows)
        print(json.dumps({"records": len(rows), "controls": 8, "repeats": args.repeats, "humanCalibration": False}))
    else:
        if args.per_stratum < 0:
            parser.error("--per-stratum must be nonnegative")
        public, private = blind_packet(read_jsonl(args.input), args.per_stratum, args.seed)
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        ratings_state = preserve_or_create_ratings(out / "ratings.jsonl", public)
        private_dir = out.parent / (out.name + "-private")
        private_dir.mkdir(parents=True, exist_ok=True)
        (private_dir / "mapping.json").write_text(json.dumps(private, indent=2, ensure_ascii=False) + "\n")
        (out / "rubric.json").write_text(json.dumps(RUBRIC, indent=2) + "\n")
        (out / "review.html").write_text(packet_html(public))
        print(json.dumps({"items": len(public), "ratingsFile": ratings_state, "newHumanRatingsInferred": 0}))


if __name__ == "__main__":
    main()
