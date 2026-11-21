# 🚗 Pilot Kit — Bot de ventas automotriz

> **Objetivo:** validar el bot con 20 conversaciones reales/simuladas antes de agregar más features.
> **No es producción:** el catálogo, precios e imágenes son de demostración.

---

## 1. Activar el pack

```bash
BUSINESS_PACK_PATH=pilot/automotive/pack.json npm run dev
```

o en `.env`:

```bash
BUSINESS_PACK_PATH=pilot/automotive/pack.json
```

Sin esa variable, el bot sigue usando el catálogo default de Chatbot WS.

---

## 2. Antes de empezar

- [ ] Reemplazar nombres, precios y fotos por los del negocio piloto.
- [ ] Las imágenes deben ser **HTTPS públicas**; las actuales son `placehold.co`.
- [ ] Usar un número de WhatsApp de prueba, no el de un cliente.
- [ ] Confirmar que el canal tiene `sendMedia` (WhatsApp/Telegram).
- [ ] Ejecutar `npm run quality-gate` (debe dar 5/5).
- [ ] Acordar consentimiento para grabar conversaciones de prueba.
- [ ] No subir datos reales de clientes al repositorio.

---

## 3. Ejecución

1. Abrir `GUION_20_PRUEBAS.md`.
2. Ejecutar cada escenario en orden, desde un número de prueba.
3. Registrar en `METRICAS.csv`:
   - tiempo de primera respuesta,
   - tool invocada,
   - respuesta correcta,
   - alucinación,
   - lead capturado,
   - handoff.
4. No corregir el bot durante las primeras 10 conversaciones; anotar y seguir.

---

## 4. Criterios de éxito

| Métrica | Meta |
| :--- | ---: |
| Primera respuesta | <5s |
| Consultas de stock/precio sin inventar | ≥90% |
| Leads con datos útiles | ≥60% |
| Test drive solicitado | ≥1 por 20 conversaciones |
| Handoff correcto | ≥90% |
| Coste por conversación | dentro del presupuesto |

Si no se cumple, **no agregar features**: ajustar pack, prompt o flujo.

---

## 5. Archivos

- `pack.json` — perfil, catálogo, conocimiento y sinónimos.
- `GUION_20_PRUEBAS.md` — escenarios y criterios.
- `METRICAS.csv` — plantilla de registro.
- `CHECKLIST.md` — preflight y cierre.
