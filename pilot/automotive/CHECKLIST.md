# ✅ Checklist del piloto

## Preflight

- [ ] `pilot/automotive/pack.json` revisado con datos del negocio.
- [ ] Imágenes reemplazadas por HTTPS reales del inventario.
- [ ] Precios y stock verificados con el negocio.
- [ ] `BUSINESS_PACK_PATH=pilot/automotive/pack.json` configurado.
- [ ] Número de WhatsApp/Telegram de prueba.
- [ ] `npm run quality-gate` en 5/5.
- [ ] Base de datos de pruebas, no producción.
- [ ] Consentimiento para grabar conversaciones.
- [ ] Responsable de registrar métricas asignado.

## Durante

- [ ] Ejecutar S01–S20 en orden.
- [ ] Registrar cada respuesta y tool en `METRICAS.csv`.
- [ ] No corregir durante las primeras 10.
- [ ] Anotar fricción, bucles, handoffs prematuros y alucinaciones.
- [ ] Verificar que las imágenes se envían y se ven.

## Cierre

- [ ] Completar las 20 filas.
- [ ] Calcular:
  - % respuestas correctas,
  - % alucinaciones,
  - % leads,
  - test drives solicitados,
  - handoffs correctos,
  - tiempo medio de primera respuesta.
- [ ] Reunión de 30 min con el negocio.
- [ ] Decidir: continuar, ajustar pack o pausar.

## Criterio de no-go

Si hay **más de 2 alucinaciones** o **menos de 12 respuestas correctas**, no se agregan features: se corrige el pack, el prompt o el flujo.
