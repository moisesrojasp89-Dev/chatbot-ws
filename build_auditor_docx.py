import os
import docx
from docx.shared import Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import parse_xml, OxmlElement
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tcPr.append(shd)

def add_code_block(doc, title, file_path, highlight_notes=None):
    # Title
    p_title = doc.add_paragraph()
    run_title = p_title.add_run(f"📄 {title}")
    run_title.bold = True
    run_title.font.size = Pt(13)
    run_title.font.color.rgb = RGBColor(0x1B, 0x36, 0x5D)
    p_title.paragraph_format.space_before = Pt(14)
    p_title.paragraph_format.space_after = Pt(4)

    # Subtitle / path
    p_path = doc.add_paragraph()
    run_path = p_path.add_run(f"Ruta: {file_path}")
    run_path.italic = True
    run_path.font.size = Pt(9.5)
    run_path.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
    p_path.paragraph_format.space_after = Pt(4)

    if highlight_notes:
        p_notes = doc.add_paragraph()
        run_notes = p_notes.add_run(f"💡 Rationale & Puntos Auditor: {highlight_notes}")
        run_notes.font.size = Pt(9.5)
        run_notes.font.bold = True
        run_notes.font.color.rgb = RGBColor(0x00, 0x66, 0x33)
        p_notes.paragraph_format.space_after = Pt(6)

    # Read content
    if not os.path.exists(file_path):
        doc.add_paragraph(f"Error: No se encontró el archivo {file_path}")
        return

    with open(file_path, "r", encoding="utf-8") as f:
        code_text = f.read()

    # Table with 1 cell for code background
    table = doc.add_table(rows=1, cols=1)
    table.alignment = docx.enum.table.WD_TABLE_ALIGNMENT.CENTER
    cell = table.cell(0, 0)
    set_cell_background(cell, "F4F6F9")
    
    # Border
    tcPr = cell._tc.get_or_add_tcPr()
    borders = parse_xml(f'<w:tcBorders {nsdecls("w")}><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:left w:val="single" w:sz="18" w:space="0" w:color="0969DA"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/></w:tcBorders>')
    tcPr.append(borders)

    cell_p = cell.paragraphs[0]
    cell_p.paragraph_format.space_before = Pt(4)
    cell_p.paragraph_format.space_after = Pt(4)
    cell_p.paragraph_format.line_spacing = 1.05
    
    # We add lines into the cell
    for line in code_text.splitlines():
        p = cell.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(1)
        p.paragraph_format.line_spacing = 1.0
        run = p.add_run(line if line else " ")
        run.font.name = "Consolas"
        run.font.size = Pt(8.5)
        run.font.color.rgb = RGBColor(0x24, 0x29, 0x2F)

    doc.add_paragraph().paragraph_format.space_after = Pt(10)

def create_doc(doc_title, doc_subtitle):
    doc = docx.Document()
    
    # Margins
    for section in doc.sections:
        section.top_margin = Inches(0.8)
        section.bottom_margin = Inches(0.8)
        section.left_margin = Inches(0.8)
        section.right_margin = Inches(0.8)

    # Header
    h = doc.add_paragraph()
    r = h.add_run(doc_title)
    r.bold = True
    r.font.size = Pt(18)
    r.font.color.rgb = RGBColor(0x0A, 0x25, 0x40)
    h.paragraph_format.space_after = Pt(2)

    sub = doc.add_paragraph()
    r_sub = sub.add_run(doc_subtitle)
    r_sub.font.size = Pt(11)
    r_sub.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
    sub.paragraph_format.space_after = Pt(12)

    # Divider line
    p_div = doc.add_paragraph()
    p_div_border = parse_xml(f'<w:pBdr {nsdecls("w")}><w:bottom w:val="single" w:sz="12" w:space="1" w:color="0969DA"/></w:pBdr>')
    p_div._p.get_or_add_pPr().append(p_div_border)
    p_div.paragraph_format.space_after = Pt(14)

    return doc

def build_part1():
    doc = create_doc(
        "Certificación Fase 5B - Parte 1: Inbound Pipeline & Resiliencia",
        "Código auditado: inboundRepository.ts e inboundDispatcher.ts"
    )
    add_code_block(
        doc,
        "Inbound Repository (Head-of-Line por sender, claim, lease, fencing token, reaper y purga LGPD)",
        "src/repositories/inboundRepository.ts",
        "Criterios 2 y 3. Punto 6 (LGPD): incluye purgeProcessedEvents(). Fencing token en markDone, SKIP LOCKED sobre tabla física."
    )
    add_code_block(
        doc,
        "Inbound Dispatcher (Daemon, Transacción Atómica Única con Fencing y Fallback, Circuit Breaker LLM)",
        "src/services/inboundDispatcher.ts",
        "Punto 1 (LLM Breaker, error transitorio vs permanente, fallback message y alerta INBOUND_TERMINAL_FAILURE). Punto 3 (efectos secundarios diferidos de lead/handoff ejecutados dentro de la transacción)."
    )
    doc.save("AUDITORIA_5B_PARTE_1_DISPATCHER_Y_REPOSITORY.docx")
    print("Guardado: AUDITORIA_5B_PARTE_1_DISPATCHER_Y_REPOSITORY.docx")

def build_part2():
    doc = create_doc(
        "Certificación Fase 5B - Parte 2: Ingesta Webhook, Apagado y Cliente LLM",
        "Código auditado: webhookController.ts, server.ts y geminiClient.ts"
    )
    add_code_block(
        doc,
        "Webhook Controller (Ingesta síncrona duradera, única compuerta UNIQUE(wamid) sin idempotencyGate heredado)",
        "src/controllers/webhookController.ts",
        "Criterio 1 y Punto 4: ACK 200 tras insertar en inbound_events. Si falla DB -> 500. Sin dependencias heredadas de idempotencyGate ni código muerto."
    )
    add_code_block(
        doc,
        "Server & Lifecycle (Readiness Probe /ready y Apagado Coordinado con presupuesto de 25s)",
        "src/server.ts",
        "Criterio 4 y Punto 7: Drenado coordinado de inboundDispatcher y outboxDispatcher en 25s. /ready pasa a 503 inmediatamente."
    )
    add_code_block(
        doc,
        "Cliente LLM (Gemini 2.5 Flash con Timeout Estricto de 20s y Clasificación de Errores)",
        "src/providers/llm/geminiClient.ts",
        "Punto 2: Timeout de 20s claramente menor al lease de 30s. Helper isTransientLlmError() para discriminar 5xx/429/timeout de errores 4xx de usuario."
    )
    doc.save("AUDITORIA_5B_PARTE_2_WEBHOOK_SERVER_Y_LLM.docx")
    print("Guardado: AUDITORIA_5B_PARTE_2_WEBHOOK_SERVER_Y_LLM.docx")

def build_part3():
    doc = create_doc(
        "Certificación Fase 5B - Parte 3: Migraciones y Sanitización Forense de Logs",
        "Código auditado: Migraciones 007, 008, 009, 010 y logger.ts"
    )
    add_code_block(
        doc,
        "Migración 007 (Status Events Deduplicación e Índice Único)",
        "src/database/migrations/007_status_events_dedup_and_unique.sql",
        "Ajuste 5A pendiente: clave única wamid + status y piso sent."
    )
    add_code_block(
        doc,
        "Migración 008 (Tabla inbound_events con Índices Parciales)",
        "src/database/migrations/008_inbound_events_table.sql",
        "Criterio 1 y 2: Tabla física inbound_events con índices parciales WHERE status = 'PENDING'."
    )
    add_code_block(
        doc,
        "Migración 009 (Row Level Security en 9 Tablas de Backend)",
        "src/database/migrations/009_enable_rls_backend_tables.sql",
        "Criterio 5 (I20): ENABLE ROW LEVEL SECURITY en todas las tablas sensibles."
    )
    add_code_block(
        doc,
        "Migración 010 (Segunda Capa: Revocación Total a anon y authenticated)",
        "src/database/migrations/010_revoke_anon_authenticated_permissions.sql",
        "Punto 5: REVOKE ALL ON TABLE ... FROM anon, authenticated para evitar filtraciones ante políticas permisivas futuras."
    )
    add_code_block(
        doc,
        "Logger Sanitizer (Enmascaramiento de Teléfonos, Tokens, Mensajes y Errores PG/Meta)",
        "src/utils/logger.ts",
        "Criterio 6 (I20): Sanitización de PII, redactando teléfonos a 55119****0001, tokens a [REDACTED], y purgando queries/parámetros en errores de Postgres."
    )
    doc.save("AUDITORIA_5B_PARTE_3_MIGRACIONES_Y_LOGGER.docx")
    print("Guardado: AUDITORIA_5B_PARTE_3_MIGRACIONES_Y_LOGGER.docx")

def build_part4():
    doc = create_doc(
        "Certificación Fase 5B - Parte 4: Suites de Pruebas Automatizadas",
        "Código auditado: tests/inbound.test.ts y tests/rlsAndLogger.test.ts"
    )
    add_code_block(
        doc,
        "Tests de Inbound Pipeline (Mutación de Lock, Rollback Forzado, Breaker, Fallback, Reaper Shutdown y LGPD)",
        "tests/inbound.test.ts",
        "Pruebas completas: mutación (falla sin SKIP LOCKED), reversión forzada de transacciones y leads, rescate por reaper de tareas colgadas en PROCESSING, y purga LGPD."
    )
    add_code_block(
        doc,
        "Tests de RLS y Sanitización de Logs (Control Duradero de Rowsecurity, Roles anon y authenticated, PostgREST)",
        "tests/rlsAndLogger.test.ts",
        "Punto 5 y 6: Verificación de rowsecurity = true en 100% de tablas públicas, bloqueo a anon y authenticated, y captura de stream de logs sin fugas de PII."
    )
    doc.save("AUDITORIA_5B_PARTE_4_TESTS_MUTACION_ROLLBACK_RLS.docx")
    print("Guardado: AUDITORIA_5B_PARTE_4_TESTS_MUTACION_ROLLBACK_RLS.docx")

def build_complete():
    doc = create_doc(
        "Certificación Fase 5B - Expediente Completo de Auditoría",
        "Chatbot WS - Implementación Exhaustiva de Inbound Durable (I18), Resiliencia y Seguridad RLS/PII (I20)"
    )
    
    # 1. Pipeline & Repos
    add_code_block(
        doc,
        "1. Inbound Repository (Head-of-Line por sender, claim, lease, fencing token, reaper y purga LGPD)",
        "src/repositories/inboundRepository.ts",
        "Criterios 2 y 3. Punto 6 (LGPD): incluye purgeProcessedEvents(). Fencing token en markDone, SKIP LOCKED sobre tabla física."
    )
    add_code_block(
        doc,
        "2. Inbound Dispatcher (Daemon, Transacción Atómica Única con Fencing y Fallback, Circuit Breaker LLM)",
        "src/services/inboundDispatcher.ts",
        "Punto 1 (LLM Breaker, error transitorio vs permanente, fallback message y alerta INBOUND_TERMINAL_FAILURE). Punto 3 (efectos secundarios diferidos de lead/handoff ejecutados dentro de la transacción)."
    )

    # 2. Ingesta, Server y LLM
    add_code_block(
        doc,
        "3. Webhook Controller (Ingesta síncrona duradera, única compuerta UNIQUE(wamid) sin idempotencyGate heredado)",
        "src/controllers/webhookController.ts",
        "Criterio 1 y Punto 4: ACK 200 tras insertar en inbound_events. Si falla DB -> 500. Sin dependencias heredadas de idempotencyGate ni código muerto."
    )
    add_code_block(
        doc,
        "4. Server & Lifecycle (Readiness Probe /ready y Apagado Coordinado con presupuesto de 25s)",
        "src/server.ts",
        "Criterio 4 y Punto 7: Drenado coordinado de inboundDispatcher y outboxDispatcher en 25s. /ready pasa a 503 inmediatamente."
    )
    add_code_block(
        doc,
        "5. Cliente LLM (Gemini 2.5 Flash con Timeout Estricto de 20s y Clasificación de Errores)",
        "src/providers/llm/geminiClient.ts",
        "Punto 2: Timeout de 20s claramente menor al lease de 30s. Helper isTransientLlmError() para discriminar 5xx/429/timeout de errores 4xx de usuario."
    )

    # 3. Migraciones y Logger
    add_code_block(
        doc,
        "6. Migración 007 (Status Events Deduplicación e Índice Único)",
        "src/database/migrations/007_status_events_dedup_and_unique.sql",
        "Ajuste 5A pendiente: clave única wamid + status y piso sent."
    )
    add_code_block(
        doc,
        "7. Migración 008 (Tabla inbound_events con Índices Parciales)",
        "src/database/migrations/008_inbound_events_table.sql",
        "Criterio 1 y 2: Tabla física inbound_events con índices parciales WHERE status = 'PENDING'."
    )
    add_code_block(
        doc,
        "8. Migración 009 (Row Level Security en 9 Tablas de Backend)",
        "src/database/migrations/009_enable_rls_backend_tables.sql",
        "Criterio 5 (I20): ENABLE ROW LEVEL SECURITY en todas las tablas sensibles."
    )
    add_code_block(
        doc,
        "9. Migración 010 (Segunda Capa: Revocación Total a anon y authenticated)",
        "src/database/migrations/010_revoke_anon_authenticated_permissions.sql",
        "Punto 5: REVOKE ALL ON TABLE ... FROM anon, authenticated para evitar filtraciones ante políticas permisivas futuras."
    )
    add_code_block(
        doc,
        "10. Logger Sanitizer (Enmascaramiento de Teléfonos, Tokens, Mensajes y Errores PG/Meta)",
        "src/utils/logger.ts",
        "Criterio 6 (I20): Sanitización de PII, redactando teléfonos a 55119****0001, tokens a [REDACTED], y purgando queries/parámetros en errores de Postgres."
    )

    # 4. Tests
    add_code_block(
        doc,
        "11. Tests de Inbound Pipeline (Mutación de Lock, Rollback Forzado, Breaker, Fallback, Reaper Shutdown y LGPD)",
        "tests/inbound.test.ts",
        "Pruebas completas: mutación (falla sin SKIP LOCKED), reversión forzada de transacciones y leads, rescate por reaper de tareas colgadas en PROCESSING, y purga LGPD."
    )
    add_code_block(
        doc,
        "12. Tests de RLS y Sanitización de Logs (Control Duradero de Rowsecurity, Roles anon y authenticated, PostgREST)",
        "tests/rlsAndLogger.test.ts",
        "Punto 5 y 6: Verificación de rowsecurity = true en 100% de tablas públicas, bloqueo a anon y authenticated, y captura de stream de logs sin fugas de PII."
    )

    doc.save("AUDITORIA_FASE_5B_COMPLETO.docx")
    print("Guardado: AUDITORIA_FASE_5B_COMPLETO.docx")

if __name__ == "__main__":
    print("Generando documentos DOCX para el auditor...")
    build_part1()
    build_part2()
    build_part3()
    build_part4()
    build_complete()
    print("¡Todos los documentos DOCX generados exitosamente!")
