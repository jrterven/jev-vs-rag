#!/usr/bin/env python3
"""Render a Spanish development readout and descriptive scientific figures from actual files."""
import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import statistics
import sys

from analyze import analyze, discovered_metrics, link_accuracy, question_id, read_results, result_index
from calibration import METRICS, read_jsonl

ORDER = ["bm25", "openai-dense", "bge-m3", "hybrid", "hybrid-bge", "hybrid-jev", "jev-scan", "oracle", "closed-book"]
LABELS = {"bm25": "BM25", "openai-dense": "OpenAI dense", "bge-m3": "BGE-M3 dense", "hybrid": "Hybrid RRF",
          "hybrid-bge": "Hybrid + BGE", "hybrid-jev": "Hybrid + Jev", "jev-scan": "Jev full scan", "oracle": "Oracle", "closed-book": "Closed-book"}
COLORS = {"bm25": "#595959", "openai-dense": "#D55E00", "bge-m3": "#590059", "hybrid": "#009999", "hybrid-bge": "#009E73", "hybrid-jev": "#990099", "jev-scan": "#0072B2", "oracle": "#343E4B", "closed-book": "#737373"}


def method_order(method):
    return (ORDER.index(method) if method in ORDER else len(ORDER), method)


def fmt(value, digits=3):
    return "—" if value is None else f"{float(value):.{digits}f}"


def money(value):
    return "—" if value is None else f"{float(value):.8f}".rstrip("0").rstrip(".") or "0"


def metric_cell(group, metric):
    if group is None:
        return "—"
    values = group["metrics"][metric]
    if not values["requested"]:
        return f"N/A ({values['notApplicable']})"
    return f"{fmt(values['questionWeighted']['mean'])} [{values['scored']}/{values['requested']}]"


def markdown_table(headers, rows):
    clean = lambda value: str(value).replace("|", "\\|").replace("\n", " ")
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |", *["| " + " | ".join(clean(value) for value in row) + " |" for row in rows]])


def combine_accuracy(rows, results, accuracy_rows, accuracy_results):
    linked = link_accuracy(rows, accuracy_rows, accuracy_results)
    combined_rows, combined_results = [], list(results)
    for row in rows:
        meta = {**row.get("metadata", {}), "notApplicable": {**row.get("metadata", {}).get("notApplicable", {})}}
        metrics = list(row.get("metrics", []))
        if row["id"] in linked:
            metrics.append("answer_accuracy")
            if linked[row["id"]] is not None:
                combined_results.append({**linked[row["id"]], "id": row["id"], "sampleId": row["id"]})
        else:
            meta["notApplicable"]["answer_accuracy"] = "unanswerable_reference" if meta.get("unanswerable") else "not_in_additive_evaluation"
        combined_rows.append({**row, "metrics": metrics, "metadata": meta})
    return combined_rows, combined_results


def duplicate_input_audit(rows, results):
    indexed, grouped = result_index(rows, results), defaultdict(list)
    for row in rows:
        key = json.dumps([row["question"], row["response"], row.get("reference")], ensure_ascii=False)
        grouped[key].append(row)
    duplicates = []
    for content, members in grouped.items():
        if len(members) < 2:
            continue
        values = [indexed[(row["id"], "answer_accuracy")]["score"] for row in members if (row["id"], "answer_accuracy") in indexed and indexed[(row["id"], "answer_accuracy")]["status"] == "completed"]
        duplicates.append({"inputHash": hashlib.sha256(content.encode()).hexdigest(), "records": len(members), "scored": len(values),
                           "range": max(values) - min(values) if values else None,
                           "samples": [{"id": row["id"], "cohort": row["metadata"]["cohort"], "method": row["metadata"]["method"]} for row in members]})
    return {"kind": "observational-identical-input-audit", "duplicateGroups": len(duplicates), "duplicateRecords": sum(group["records"] for group in duplicates),
            "varyingGroups": sum(group["range"] is not None and group["range"] > 0 for group in duplicates),
            "maximumRange": max((group["range"] for group in duplicates if group["range"] is not None), default=None), "groups": duplicates,
            "policy": "Natural duplicate (question,response,reference) inputs, not planned repeated trials or independent questions; no confidence intervals or winner claims."}


def pilot_diagnostics(rows, results, retrieval):
    indexed, by_key = result_index(rows, results), defaultdict(list)
    for row in rows:
        if row.get("metadata", {}).get("cohort") == "pilot-positive":
            by_key[(question_id(row), row["metadata"]["method"])].append(row)
    comparisons = []
    for comparator in ("openai-dense", "hybrid-bge", "hybrid-jev"):
        question_ids = {qid for qid, method in by_key if method == "jev-scan"} & {qid for qid, method in by_key if method == comparator}
        value = {"method": "jev-scan", "comparator": comparator, "pairedQuestions": 0, "ambiguousQuestions": 0,
                 "scoredPairs": 0, "higher": 0, "equal": 0, "lower": 0, "unscoredPairs": 0,
                 "comparablePayloadHashes": 0, "identicalGenerationPayloads": 0, "identicalResponseTexts": 0}
        for qid in sorted(question_ids):
            left, right = by_key[(qid, "jev-scan")], by_key[(qid, comparator)]
            if len(left) != 1 or len(right) != 1:
                value["ambiguousQuestions"] += 1
                continue
            left, right = left[0], right[0]
            value["pairedQuestions"] += 1
            left_hash, right_hash = left["metadata"].get("generationPayloadHash"), right["metadata"].get("generationPayloadHash")
            if left_hash and right_hash:
                value["comparablePayloadHashes"] += 1
                value["identicalGenerationPayloads"] += left_hash == right_hash
            value["identicalResponseTexts"] += left["response"] == right["response"]
            scores = [indexed.get((row["id"], "answer_accuracy")) for row in (left, right)]
            if not all(score and score["status"] == "completed" for score in scores):
                value["unscoredPairs"] += 1
                continue
            value["scoredPairs"] += 1
            a, b = [score["score"] for score in scores]
            value["higher" if a > b else "lower" if a < b else "equal"] += 1
        if value["pairedQuestions"] or value["ambiguousQuestions"]:
            comparisons.append(value)
    flagged = [row for row in rows if "Answer with content missing:" in row.get("reference", "")]
    by_document = {item["documentId"]: item for item in retrieval.get("preparation", [])}
    chunks = [item["chunks"] for item in by_document.values() if isinstance(item.get("chunks"), int)]
    scans = [run for run in retrieval.get("perQuery", []) if run.get("method") == "jev-scan" and run.get("round") == 0 and run.get("status") == "completed"]
    windows = Counter(sum(trace.get("stage") == "window" and trace.get("level") == 0 for trace in run["traces"]) for run in scans if isinstance(run.get("traces"), list))
    return {"kind": "descriptive-pilot-diagnostics", "pairedAnswerAccuracy": comparisons,
            "referenceMissingContent": {"marker": "Answer with content missing:", "records": len(flagged), "questionIds": sorted({question_id(row) for row in flagged}),
                                        "cicFormulaRecords": sum("formula for CIC" in row.get("reference", "") for row in flagged),
                                        "cohortRecords": dict(Counter(row["metadata"]["cohort"] for row in flagged)), "sampleIds": [row["id"] for row in flagged]},
            "retrievalScope": {"preparedDocuments": len(by_document), "documentsWithChunkCounts": len(chunks), "minimumChunks": min(chunks) if chunks else None,
                               "maximumChunks": max(chunks) if chunks else None, "medianChunks": statistics.median(chunks) if chunks else None,
                               "documentsOver50Chunks": sum(value > 50 for value in chunks), "firstRoundCompletedScans": len(scans),
                               "firstRoundScansWithTraces": sum(windows.values()), "initialWindowCounts": {str(key): value for key, value in sorted(windows.items())}},
            "policy": "Descriptive paired counts only, within the original positive pilot. Identical generation payloads do not imply identical sampled responses. No causal attribution to retrieval, statistical tests, retrospective exclusions, or repaired reference labels."}


def make_readout(rows, results, controls, retrieval, budget, accuracy_rows=None, accuracy_results=None, accuracy_controls=None, accuracy_budget=None):
    if any(row.get("metadata", {}).get("synthetic") or row.get("metadata", {}).get("control") for row in rows):
        raise ValueError("Keep synthetic technical controls in their separate control summary")
    if retrieval.get("kind") != "measured" or not retrieval.get("methods"):
        raise ValueError("Retrieval table requires the original measured report")
    original_rows = rows
    if accuracy_rows is not None:
        rows, results = combine_accuracy(rows, results, accuracy_rows, accuracy_results or [])
    summary = analyze(rows, results)
    diagnostics = pilot_diagnostics(rows, results, retrieval)
    summary["pilotDiagnostics"] = diagnostics
    correctness_metric = "answer_accuracy" if accuracy_rows is not None else "factual_correctness"
    correctness_label = "Answer Accuracy (pregunta)" if accuracy_rows is not None else "Factual Correctness (diagnóstico)"
    groups = summary["groups"]
    pilot = [row for row in rows if row.get("metadata", {}).get("cohort") == "pilot-positive"]
    pilot_questions = len({question_id(row) for row in pilot})
    lookup = {(group["cohort"], group["method"], group["unanswerable"]): group for group in groups}
    retrieval_methods = retrieval["methods"]
    keys = [(row["id"], row.get("corpus")) for row in retrieval_methods]
    if len(set(keys)) != len(keys):
        raise ValueError("Duplicate method/corpus in retrieval report")
    if len({row.get("corpus") for row in retrieval_methods}) != 1:
        raise ValueError("Select a single original retrieval corpus; do not silently pool corpora")
    technical = controls.get("technicalControls", controls)
    metric_checks = [value for control in technical.get("controls", []) for value in control["metrics"].values()]
    passed = sum(value["allExpectedRangesPassed"] for value in metric_checks)
    complete = sum(value["allRepeatsScored"] for value in metric_checks)
    stable = sum(value.get("stabilityRangeAtMost025") is True for value in metric_checks)
    negative = [row for row in rows if row.get("metadata", {}).get("cohort") == "negative-diagnostic"]
    abstentions = []
    for unanswerable in (True, False):
        for method in sorted({row["metadata"]["method"] for row in negative if bool(row["metadata"].get("unanswerable")) == unanswerable}, key=method_order):
            members = [row for row in negative if row["metadata"]["method"] == method and bool(row["metadata"].get("unanswerable")) == unanswerable]
            abstentions.append({"method": method, "unanswerable": unanswerable, "records": len(members),
                                "questions": len({question_id(row) for row in members}),
                                "abstained": sum(row["metadata"].get("abstained") is True for row in members),
                                "answered": sum(row["metadata"].get("abstained") is False for row in members),
                                "unknown": sum(row["metadata"].get("abstained") not in (True, False) for row in members)})
    quality_counts = sorted({row.get("nQueries") for row in retrieval_methods if row.get("nQueries") is not None})
    timing_counts = sorted({row.get("nTimingRuns") for row in retrieval_methods if row.get("nTimingRuns") is not None})
    qtext = "/".join(map(str, quality_counts)) or "no reportadas"
    ttext = "/".join(map(str, timing_counts)) or "no reportadas"
    lines = ["# RAGAS sobre respuestas de desarrollo", "",
             f"Se conservan {summary['inputRecords']} respuestas de {summary['uniqueQuestionsOverall']} preguntas únicas en cohortes separadas. El piloto positivo aporta {len(pilot)} respuestas de {pilot_questions} preguntas. Son resultados exploratorios de desarrollo; no constituyen evaluación del test ni calibración humana.", "",
             "## Piloto positivo: recuperación y generación", "",
             f"La recuperación original usa {qtext} consultas de calidad y {ttext} ejecuciones cronometradas por método. Sus métricas se copian del reporte medido original (agregación: `{retrieval.get('aggregation', 'no reportada')}`). RAGAS usa el subconjunto de {pilot_questions} preguntas y las respuestas ya generadas; sus medias son por pregunta dentro de cada método.", "",
             "En las dos columnas RAGAS, `[n/N]` significa puntuaciones calculadas / solicitadas. N/A queda fuera de ese denominador; un fallo o dato pendiente nunca vale cero. Los promedios pueden tener denominadores distintos.", ""]
    table = []
    for row in sorted(retrieval_methods, key=lambda row: method_order(row["id"])):
        group = lookup.get(("pilot-positive", row["id"], False))
        coverage = row.get("coverage")
        table.append([LABELS.get(row["id"], row["id"]), fmt(coverage * 100 if coverage is not None else None, 1), fmt(row.get("latencyP50Ms"), 1), money(row.get("preparationUsd")), money(row.get("queryMeanUsd")), metric_cell(group, "faithfulness"), metric_cell(group, correctness_metric)])
    lines += [markdown_table(["Método", "Cobertura @5 (%)", "Mediana (ms)", "Prep. USD/doc.", "Consulta USD", "Faithfulness", correctness_label], table), "",
              "Los costos son de APIs, no incluyen cómputo local ni generación ni juez. Preparación y consulta conservan las unidades/agregación del reporte original.", ""]
    controls_table = [[LABELS[method], metric_cell(lookup.get(("pilot-positive", method, False)), "faithfulness"), metric_cell(lookup.get(("pilot-positive", method, False)), correctness_metric)] for method in ("oracle", "closed-book")]
    lines += ["Controles de generación, sin métricas de recuperación:", "", markdown_table(["Control", "Faithfulness", correctness_label], controls_table), "",
              "Faithfulness juzga las afirmaciones frente al contexto realmente suministrado. Es una media condicional: se excluyen abstenciones explícitas y ausencia de contexto; no determina si se respondió la pregunta. Factual Correctness es F1 frente a la primera referencia humana congelada; una redacción alternativa válida puede diferir de esa referencia. Ninguna de estas métricas evalúa directamente las citas elegidas.", ""]
    missing_reference = diagnostics["referenceMissingContent"]
    if missing_reference["records"]:
        cic_note = " El caso de CIC contiene «Answer with content missing: (formula for CIC)»." if missing_reference["cicFormulaRecords"] else ""
        lines += [f"La referencia declara explícitamente contenido faltante en {missing_reference['records']} respuestas de {len(missing_reference['questionIds'])} pregunta(s), incluidas {missing_reference['cohortRecords'].get('pilot-positive', 0)} respuestas del piloto.{cic_note} Answer Accuracy presupone una referencia suficiente y no garantiza un oro completo cuando faltan datos. Se conservan todas las observaciones; este diagnóstico derivado no reemplaza la referencia ni constituye una etiqueta humana.", ""]
    scope = diagnostics["retrievalScope"]
    if scope["documentsWithChunkCounts"]:
        lines += [f"El reporte original registra {scope['preparedDocuments']} documentos preparados: entre {scope['minimumChunks']} y {scope['maximumChunks']} fragmentos, mediana {fmt(scope['medianChunks'], 0)}; {scope['documentsOver50Chunks']} superan 50 fragmentos. Este piloto no establece el comportamiento sobre libros completos ni sobre una selección inicial mayor a 50 candidatos.", ""]
    if scope["firstRoundScansWithTraces"]:
        windows_text = "; ".join(f"{count} consultas con {windows} ventana(s)" for windows, count in scope["initialWindowCounts"].items())
        lines += [f"Trazas de Jev completo, primera ronda y ventanas iniciales: {windows_text} ({scope['firstRoundScansWithTraces']} consultas con trazas).", ""]
    if accuracy_rows is not None and diagnostics["pairedAnswerAccuracy"]:
        lines += ["Comparación emparejada descriptiva de Answer Accuracy en el piloto (Jev completo frente a cada comparador):", "",
                  markdown_table(["Comparador", "Pares puntuados", "Jev mayor", "Igual", "Jev menor", "Sin score"], [[LABELS[value["comparator"]], value["scoredPairs"], value["higher"], value["equal"], value["lower"], value["unscoredPairs"]] for value in diagnostics["pairedAnswerAccuracy"]]), "",
                  "Son diferencias en puntuaciones de pocas preguntas, no pruebas de superioridad ni respuestas binarias correctas/incorrectas.", ""]
    hybrid_pair = next((value for value in diagnostics["pairedAnswerAccuracy"] if value["comparator"] == "hybrid-jev"), None)
    if hybrid_pair:
        lines += [f"Jev completo y Hybrid + Jev comparten exactamente el cuerpo de petición al generador en {hybrid_pair['identicalGenerationPayloads']}/{hybrid_pair['comparablePayloadHashes']} pares con hashes verificables; el texto de respuesta coincide en {hybrid_pair['identicalResponseTexts']}/{hybrid_pair['pairedQuestions']} pares. No se atribuyen automáticamente sus diferencias de Answer Accuracy a la recuperación: también pueden intervenir la generación y el juez.", ""]
    lines += ["## Denominadores y cohortes", ""]
    denominator_rows = []
    for group in sorted(groups, key=lambda group: (group["cohort"], group["unanswerable"], method_order(group["method"]))):
        for metric in discovered_metrics(rows):
            value = group["metrics"][metric]
            denominator_rows.append([group["cohort"], "negativa" if group["unanswerable"] else "respondible", LABELS.get(group["method"], group["method"]), metric,
                                     fmt(value["questionWeighted"]["mean"]), f"{value['scored']}/{value['requested']}", value["scoredQuestions"], value["notApplicable"], value["error"], value["unscorable"], value["missing"]])
    lines += [markdown_table(["Cohorte", "Tipo", "Método", "Métrica", "Media", "n/N", "Preguntas", "N/A", "Error", "Sin score", "Pendiente"], denominator_rows), "",
              f"Hay {summary['questionsAppearingInMultipleCohorts']} preguntas presentes en más de una cohorte. No se combinan esas respuestas ni los controles positivos del diagnóstico con el piloto. Cada pregunta repetida tiene peso uno dentro de su estrato. El detalle de motivos N/A y errores permanece en `readout.json`.", "",
              "## Abstención en el diagnóstico", "",
              "Se cuentan las abstenciones explícitas registradas al generar. Las preguntas negativas no tienen una referencia factual positiva y su abstención no recibe una puntuación RAGAS inventada. Las etiquetas negativas de desarrollo provienen de un anotador original por pregunta.", "",
              markdown_table(["Tipo", "Método", "Respuestas", "Preguntas", "Abstuvo", "Respondió", "Sin dato"], [["negativa" if row["unanswerable"] else "control positivo", LABELS.get(row["method"], row["method"]), row["records"], row["questions"], row["abstained"], row["answered"], row["unknown"]] for row in abstentions]), "",
              "## Controles técnicos del juez", "",
              f"{passed}/{len(metric_checks)} combinaciones control–métrica cumplen todos los rangos esperados; {complete}/{len(metric_checks)} tienen todas las repeticiones puntuadas. {stable}/{len(metric_checks)} muestran un rango entre repeticiones ≤0.25. Estos controles son sintéticos y no sustituyen calificaciones humanas.", ""]
    technical_rows = []
    for control in technical.get("controls", []):
        for metric, value in control["metrics"].items():
            technical_rows.append([control["control"], metric, f"{value['n']}/{value['plannedRepeats']}", fmt(value["mean"]), fmt(value["range"]), "sí" if value["allExpectedRangesPassed"] else "no / incompleto"])
    lines += [markdown_table(["Control técnico", "Métrica", "Repeticiones", "Media", "Rango", "Cumple"], technical_rows), "",
              "Factual Correctness compara la respuesta con la referencia sin condicionar el juicio en la pregunta. Por ello puede dar crédito a hechos compartidos que no responden lo preguntado; su puntuación no equivale a utilidad para esa pregunta.", ""]
    reference_control = next((control for control in technical.get("controls", []) if control["control"] == "supported-but-reference-contradicted"), None)
    if reference_control and not reference_control["metrics"]["factual_correctness"]["allExpectedRangesPassed"] and reference_control["metrics"]["factual_correctness"]["n"]:
        lines += ["El control `supported-but-reference-contradicted` no cumple el rango predefinido de Factual Correctness. Aunque fecha y ubicación se contradicen, ambos textos conservan el hecho compartido de que el observatorio es ficticio, al que la descomposición puede dar crédito. Se conserva el incumplimiento; no se ajustó el rango después de observar el resultado. Las métricas de desarrollo siguen siendo exploratorias.", ""]
    lines += ["La comparación con humanos sigue pendiente hasta importar valoraciones realmente completadas en el paquete ciego. No se infieren etiquetas humanas de los controles ni de las puntuaciones del juez.", "", "## Costo de evaluación", ""]
    evaluation = budget.get("evaluation")
    if evaluation:
        lines += [f"Juez: USD {money(evaluation.get('knownUsd'))} conocidos y USD {money(evaluation.get('reservedUsd'))} reservados; {evaluation.get('unknownAttempts', '—')} intentos pendientes o de consumo desconocido. El costo del juez se informa por separado de preparación, recuperación y generación.", ""]
    else:
        lines += ["El archivo de presupuesto no distingue el costo de esta evaluación; se conserva completo en el JSON sin atribuirlo al juez.", ""]
    if budget.get("global"):
        lines += [f"Ledger global: USD {money(budget['global'].get('committedUsd'))} comprometidos incluyendo reservas.", ""]
    if accuracy_rows is not None:
        accuracy_summary = analyze(accuracy_rows, accuracy_results or [])
        duplicates = duplicate_input_audit(accuracy_rows, accuracy_results or [])
        accuracy_questions = len({question_id(row) for row in accuracy_rows})
        lines += ["## Answer Accuracy: fase adicional con pregunta", "",
                  f"La fase adicional evalúa {len(accuracy_rows)} respuestas positivas de {accuracy_questions} preguntas únicas. El piloto conserva sus {pilot_questions} preguntas; el diagnóstico positivo se reporta separado y solo algunas preguntas se solapan. Se mantienen la pregunta original, la respuesta generada y la referencia humana congelada, incluidas referencias breves como Yes, Wikipedia o KVRET.", "",
                  "Answer Accuracy es la métrica principal de corrección de esta lectura porque recibe la pregunta. Se agregó tras detectar la limitación de Factual Correctness; no sustituye ni reescribe los resultados de la primera fase, y tampoco equivale a un veredicto humano.", "",
                  f"En los duplicados naturales de (pregunta, respuesta, referencia) hay {duplicates['duplicateGroups']} grupos / {duplicates['duplicateRecords']} registros; {duplicates['varyingGroups']} grupos varían, con rango máximo {fmt(duplicates['maximumRange'])}. Es una auditoría observacional de entradas repetidas, no un ensayo de estabilidad programado ni preguntas independientes. No se infieren intervalos ni un ganador.", ""]
        if accuracy_controls:
            accuracy_technical = accuracy_controls.get("technicalControls", accuracy_controls)
            checks = [value for control in accuracy_technical.get("controls", []) for value in control["metrics"].values()]
            lines += [f"Controles técnicos adicionales: {sum(value['allExpectedRangesPassed'] for value in checks)}/{len(checks)} combinaciones cumplen los rangos predefinidos; {sum(value['n'] for value in checks)}/{sum(value['plannedRepeats'] for value in checks)} repeticiones puntuadas. Son controles sintéticos, no calibración humana.", ""]
            summary["answerAccuracyTechnicalControls"] = accuracy_technical
        if accuracy_budget and accuracy_budget.get("evaluation"):
            evaluation = accuracy_budget["evaluation"]
            lines += [f"Costo de esta fase adicional: USD {money(evaluation.get('knownUsd'))} conocidos, USD {money(evaluation.get('reservedUsd'))} reservados. No se suma el ledger global dos veces.", ""]
            summary["answerAccuracyBudget"] = accuracy_budget
        lines += ["Factual Correctness se conserva como diagnóstico de coincidencia con la referencia, no como precisión de respuesta:", "",
                  markdown_table(["Método / control", "Factual Correctness (piloto)"], [[LABELS.get(method, method), metric_cell(lookup.get(("pilot-positive", method, False)), "factual_correctness")] for method in ORDER]), ""]
        summary["answerAccuracy"] = accuracy_summary
        summary["answerAccuracyDuplicateInputAudit"] = duplicates
        summary["originalInputRecords"] = len(original_rows)
        summary["primaryCorrectnessMetric"] = "answer_accuracy"
    summary.update({"originalRetrievalReport": {key: retrieval.get(key) for key in ("experimentId", "datasetHash", "aggregation", "methods")},
                    "budget": budget, "technicalControls": technical, "negativeDiagnosticAbstention": abstentions,
                    "humanCalibration": {"status": "pending-actual-ratings", "scoresInferred": False}})
    return summary, "\n".join(lines)


def render_figures(rows, results, summary, out):
    # Import lazily so the readout remains usable in an ordinary stdlib environment.
    os.environ.setdefault("MPLCONFIGDIR", str(out / ".matplotlib"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    indexed = result_index(rows, results)
    paths = []
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "axes.labelsize": 11, "axes.titlesize": 14, "svg.fonttype": "none", "savefig.facecolor": "white"})
    strata = sorted({(row["metadata"]["cohort"], bool(row["metadata"].get("unanswerable"))) for row in rows if not row["metadata"].get("synthetic")})
    for cohort, unanswerable in strata:
        members = [row for row in rows if row["metadata"]["cohort"] == cohort and bool(row["metadata"].get("unanswerable")) == unanswerable]
        methods = sorted({row["metadata"]["method"] for row in members}, key=method_order)
        groups = {group["method"]: group for group in summary["groups"] if group["cohort"] == cohort and group["unanswerable"] == unanswerable}
        positions = {method: index + (0.55 if method in ("oracle", "closed-book") and any(m not in ("oracle", "closed-book") for m in methods) else 0) for index, method in enumerate(methods)}
        fig, axes = plt.subplots(1, 2, figsize=(15.4, max(6.5, .54 * len(methods) + 2.0)), sharey=True)
        figure_metrics = ("faithfulness", summary.get("primaryCorrectnessMetric", "factual_correctness"))
        for axis, metric in zip(axes, figure_metrics):
            for method in methods:
                by_question = defaultdict(list)
                for row in members:
                    value = indexed.get((row["id"], metric))
                    if row["metadata"]["method"] == method and value and value["status"] == "completed":
                        by_question[question_id(row)].append(value["score"])
                values = [(qid, statistics.mean(scores)) for qid, scores in sorted(by_question.items())]
                y = positions[method]
                for qid, score in values:
                    jitter = (int(hashlib.sha256(qid.encode()).hexdigest()[:8], 16) / (2**32 - 1) - .5) * .34
                    axis.scatter(score, y + jitter, s=28, color=COLORS.get(method, "#595959"), alpha=.55, linewidths=0, zorder=3)
                denominator = groups[method]["metrics"][metric]
                if values:
                    mean = statistics.mean(score for _, score in values)
                    axis.scatter(mean, y, s=80, marker="D", facecolors="white", edgecolors=COLORS.get(method, "#595959"), linewidths=1.8, zorder=5)
                    label = f"{mean:.3f}  [{denominator['scored']}/{denominator['requested']}]"
                else:
                    label = f"N/A ({denominator['notApplicable']})" if not denominator["requested"] else f"Sin score [0/{denominator['requested']}]"
                axis.text(1.035, y, label, va="center", fontsize=10, clip_on=False)
            axis.set_xlim(-.025, 1.015)
            axis.set_xticks([0, .25, .5, .75, 1])
            axis.set_xticklabels(["0", "0.25", "0.50", "0.75", "1"])
            axis.set_xlabel("Puntuación (0–1)")
            title = {"faithfulness": "Faithfulness", "factual_correctness": "Factual Correctness · diagnóstico", "answer_accuracy": "Answer Accuracy · con pregunta"}[metric]
            axis.set_title(title, loc="left", fontweight="bold", pad=15)
            axis.grid(axis="x", color="#e2e5e9", linewidth=.8)
            axis.set_axisbelow(True)
            axis.set_yticks([positions[method] for method in methods], [LABELS.get(method, method) for method in methods])
            axis.tick_params(axis="y", length=0, pad=10)
            for spine in ("top", "right", "left"):
                axis.spines[spine].set_visible(False)
            axis.spines["bottom"].set_color("#bdc5cd")
            retrievers = [m for m in methods if m not in ("oracle", "closed-book")]
            if retrievers and len(retrievers) < len(methods):
                axis.axhline(len(retrievers) - .225, color="#c4cbd3", linestyle="--", linewidth=.8)
        axes[0].set_ylim(max(positions.values()) + .65, -.6)
        n_questions = len({question_id(row) for row in members})
        scope = "preguntas negativas" if unanswerable else "preguntas respondibles"
        fig.suptitle(f"{cohort} · {scope} · {n_questions} preguntas", x=.14, ha="left", fontsize=15, fontweight="bold", y=.985)
        fig.legend(handles=[Line2D([], [], color="#64748b", marker="o", linestyle="none", markersize=5, alpha=.6, label="Una pregunta"), Line2D([], [], color="#343e4b", marker="D", markerfacecolor="white", linestyle="none", markersize=7, label="Media por pregunta")], loc="lower left", bbox_to_anchor=(.13, .037), frameon=False, ncol=2)
        fig.text(.14, .02, "[n/N]: puntuaciones calculadas / solicitadas. N/A excluido. Dispersión descriptiva; sin intervalos de confianza.", fontsize=9, color="#4b5563")
        fig.subplots_adjust(left=.145, right=.87, top=.87, bottom=.2, wspace=.55)
        suffix = "negative" if unanswerable else "answerable"
        stem = f"ragas-{cohort}-{suffix}"
        for extension in ("svg", "png"):
            path = out / f"{stem}.{extension}"
            fig.savefig(path, dpi=180, bbox_inches="tight")
            paths.append(path.name)
        plt.close(fig)
    return {"status": "completed", "files": paths, "matplotlib": matplotlib.__version__}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("samples", "results", "controls-summary", "retrieval-report", "budget"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("accuracy-samples", "accuracy-results", "accuracy-controls-summary", "accuracy-budget"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--out", type=Path, required=True, help="Output directory; original reports are never edited")
    parser.add_argument("--no-figures", action="store_true")
    args = parser.parse_args()
    if bool(args.accuracy_samples) != bool(args.accuracy_results):
        parser.error("Pass --accuracy-samples and --accuracy-results together")
    rows, results = read_jsonl(args.samples), read_results(args.results)
    controls, retrieval, budget = [json.loads(path.read_text()) for path in (args.controls_summary, args.retrieval_report, args.budget)]
    accuracy_rows = read_jsonl(args.accuracy_samples) if args.accuracy_samples else None
    accuracy_results = read_results(args.accuracy_results) if args.accuracy_results else None
    accuracy_controls = json.loads(args.accuracy_controls_summary.read_text()) if args.accuracy_controls_summary else None
    accuracy_budget = json.loads(args.accuracy_budget.read_text()) if args.accuracy_budget else None
    summary, markdown = make_readout(rows, results, controls, retrieval, budget, accuracy_rows, accuracy_results, accuracy_controls, accuracy_budget)
    args.out.mkdir(parents=True, exist_ok=True)
    summary["provenance"] = {name: {"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for name, path in vars(args).items() if isinstance(path, Path) and name != "out"}
    summary["runtime"] = {"python": platform.python_version(), "executable": sys.executable, "platform": platform.platform(), "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    summary["runtime"]["packages"] = {distribution.metadata["Name"]: distribution.version for distribution in importlib.metadata.distributions()}
    if args.no_figures:
        plots = {"status": "skipped-by-request", "files": []}
    else:
        try:
            figure_rows, figure_results = combine_accuracy(rows, results, accuracy_rows, accuracy_results) if accuracy_rows is not None else (rows, results)
            plots = render_figures(figure_rows, figure_results, summary, args.out)
        except ImportError as error:
            plots = {"status": "unavailable", "files": [], "error": str(error)}
            markdown += "\nFiguras no generadas: Matplotlib no está disponible en este entorno.\n"
    summary["figures"] = plots
    if plots["files"]:
        markdown += "\n## Figuras descriptivas\n\n" + "\n\n".join(f"![{filename}]({filename})" for filename in plots["files"] if filename.endswith(".png")) + "\n"
    (args.out / "readout.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    (args.out / "README.md").write_text(markdown)
    print(json.dumps({"readout": str(args.out / "README.md"), "figures": plots}))


if __name__ == "__main__":
    main()
