# 🚗 Automotive Pack Spec — Piloto de ventas

> **Estado:** especificación para piloto, no código de producción.
> **Regla de oro:** todo lo automotriz vive en `packs/automotive/`. El núcleo no conoce autos, dealers ni financiamiento.
> **Objetivo del piloto:** validar que el bot conversa, califica, cotiza, agenda test drive y deriva con contexto, sin condicionar la plantilla.

---

## 1. Alcance

- Un **concesionario multimarca** (nuevos y usados), 20–30 vehículos.
- Canales: **WhatsApp** primero; Telegram como prueba.
- Flujos: stock, precio, cotización simple, financiamiento informativo, permuta, test drive, handoff.
- **Fuera de alcance:** aprobación de crédito, pagos, contratos, integración con DMS, seguros.

---

## 2. Perfil de negocio (configurable)

```json
{
  "businessName": "Automotriz Demo",
  "vertical": "automotive",
  "language": "es",
  "timezone": "America/Caracas",
  "tone": "cálido, directo, profesional, sin presión",
  "hours": { "mon-fri": "08:00-18:00", "sat": "08:00-13:00" },
  "locations": ["Caracas", "Valencia"],
  "policies": {
    "priceCurrency": "USD",
    "priceIncludesTax": false,
    "testDriveRequiresLicense": true,
    "tradeInRequiresInspection": true
  }
}
```

---

## 3. Catálogo

### 3.1 Forma genérica del ítem

El núcleo solo conoce esta forma; lo automotriz va en `attributes`.

| Campo | Tipo | Obligatorio |
| :--- | :--- | :--- |
| `id` | string | sí |
| `name` | string | sí |
| `category` | string | sí |
| `price` | number | sí |
| `currency` | string | sí |
| `stock` | boolean | sí |
| `description` | string | no |
| `attributes` | object | sí |
| `images` | string[] | no |

### 3.2 Atributos automotrices (dentro de `attributes`)

| Atributo | Tipo | Obligatorio |
| :--- | :--- | :--- |
| `make` | string | sí |
| `model` | string | sí |
| `year` | number | sí |
| `version` | string | no |
| `condition` | `new` \| `used` | sí |
| `mileageKm` | number | usado |
| `transmission` | `manual` \| `automatic` | sí |
| `fuel` | `gasoline` \| `diesel` \| `hybrid` \| `electric` | sí |
| `bodyType` | string | no |
| `color` | string | no |
| `location` | string | sí |
| `features` | string[] | no |

### 3.3 Reglas de grounding

- El bot **no inventa** precio, stock, año, kilometraje ni disponibilidad.
- Toda cifra sale de `search_inventory` o `get_vehicle_details`.
- Si no hay coincidencia, ofrece alternativas o handoff; nunca inventa.

---

## 4. Calificación

Campos declarados por el pack y persistidos en `leads.extracted_data`:

| Campo | Ejemplo | Uso |
| :--- | :--- | :--- |
| `interest` | “SUV automática” | intención |
| `budget` | 25000 | rango |
| `paymentMethod` | contado/financiado | flujo |
| `tradeIn` | sí/no | permuta |
| `city` | Caracas | ubicación |
| `timeline` | esta semana | urgencia |
| `hasLicense` | sí/no | test drive |

`qualification_stage`: `COLD` / `WARM` / `HOT` según intención + datos + urgencia.

---

## 5. Tools del pack

Contratos genéricos; el núcleo solo ve `ToolDefinition`.

### 5.1 `search_inventory`
```json
{
  "query": "string?",
  "make": "string?",
  "model": "string?",
  "yearMin": "number?",
  "yearMax": "number?",
  "priceMax": "number?",
  "condition": "new|used?",
  "transmission": "manual|automatic?",
  "location": "string?"
}
```
Devuelve máximo 5 resultados + total, sin inventar.

### 5.2 `get_vehicle_details`
```json
{ "vehicleId": "string" }
```
Ficha completa, disponibilidad e imágenes.

### 5.3 `quote_vehicle`
```json
{ "vehicleId": "string", "paymentMethod": "cash|finance?" }
```
Cotización simple: precio, impuestos si aplica, nota de que no es aprobación de crédito.

### 5.4 `schedule_test_drive`
```json
{
  "vehicleId": "string?",
  "preferredDate": "ISO date",
  "preferredTime": "HH:mm",
  "location": "string",
  "hasLicense": "boolean"
}
```
Crea una **solicitud** de cita, no una reserva confirmada. Requiere aprobación humana si el pack lo define.

### 5.5 `capture_trade_in`
```json
{
  "make": "string",
  "model": "string",
  "year": "number",
  "mileageKm": "number",
  "conditionNotes": "string?"
}
```
Registra permuta sujeta a inspección.

### 5.6 `handoff_to_advisor`
```json
{ "reason": "USER_REQUEST|COMPLEX_QUOTE|FINANCING|COMPLAINT|OTHER", "summary": "string" }
```
Handoff por conversación con briefing.

---

## 6. Flujo conversacional

Mapeo sobre la FSM actual, sin cambiar el esquema:

| Estado actual | Uso en el pack |
| :--- | :--- |
| `IDLE` | saludo, detectar intención |
| `QUALIFYING` | necesidad, presupuesto, ciudad, permuta |
| `CATALOG_QUERY` | búsqueda, ficha, comparación |
| `BOOKING` | test drive / cita |
| `CLOSING` | confirmación, datos de contacto |
| `HUMAN_ESCALATION` | asesor |
| `CLOSED` | cierre |

### Secuencia típica
1. Saludo y detección (“busco SUV automática”).
2. Calificación breve (presupuesto, ciudad, contado/financiado).
3. `search_inventory`.
4. Ficha/cotización.
5. Test drive o handoff.
6. Registro de lead y resumen.

**Regla:** una pregunta por mensaje; no interrogar.

---

## 7. Prompt del pack

Variables:

- `{{BUSINESS_NAME}}`, `{{CITY}}`, `{{HOURS}}`, `{{TONE}}`, `{{CURRENCY}}`.
- `{{CATALOG_RULES}}`, `{{QUALIFICATION_FIELDS}}`, `{{HANDOFF_RULES}}`.

Reglas específicas:

1. No inventar stock/precio.
2. No prometer crédito ni aprobación.
3. No dar descuentos no autorizados.
4. Confirmar ciudad y forma de pago antes de cotizar.
5. Ofrecer test drive solo si hay licencia y disponibilidad.
6. Handoff ante financiamiento complejo, queja o solicitud explícita.
7. Formato adaptado al canal (no asumir WhatsApp).

---

## 8. Evaluaciones del piloto

10 escenarios mínimos:

1. “Busco una SUV automática hasta 25k” → 3 opciones válidas.
2. “¿Cuánto cuesta el modelo X?” → precio exacto del catálogo.
3. “¿Tienen stock?” → disponibilidad real.
4. “¿Financian?” → explicación informativa, sin aprobar.
5. “Quiero dar mi carro en parte de pago” → captura de permuta.
6. “Quiero agendar test drive” → datos y solicitud.
7. “¿Está disponible el que vi ayer?” → ficha correcta.
8. “Es muy caro” → objeción sin bajar precio inventado.
9. “Quiero hablar con un asesor” → handoff con contexto.
10. “No entiendo, explícame” → reformulación simple.

Métricas: precisión de catálogo, campos capturados, cita solicitada, handoff correcto, tono.

---

## 9. Implementación por fases

1. **4A.1** `BusinessProfile` + `CatalogProvider` (JSON/DB) y catálogo seed.
2. **4A.2** Tools reales del pack usando el `ToolRegistry` de 4A.1.
3. **4A.3** Prompt builder por pack/canal.
4. **4A.4** Calificación configurable y lead.
5. **4A.5** Evaluaciones.
6. **4C** media saliente (fotos del vehículo).
7. **4D** follow-up/plantillas.

---

## 10. Criterios de aceptación

- [ ] El pack se activa por configuración, sin editar `agentEngine`.
- [ ] El catálogo se carga sin código.
- [ ] El prompt no menciona WhatsApp si el canal es Telegram.
- [ ] Las 6 tools devuelven datos reales del catálogo.
- [ ] El lead guarda los campos del pack.
- [ ] Handoff con resumen y conversación correcta.
- [ ] 10 escenarios evaluados.
- [ ] El core no contiene `vehicle`, `dealer` ni `test_drive`.

---

## 11. Riesgos

| Riesgo | Mitigación |
| :--- | :--- |
| Alucinación de precio/stock | grounding obligatorio + tools |
| Crédito prometido | lenguaje informativo + handoff |
| Datos de permuta incompletos | validación y inspección humana |
| Catálogo desactualizado | fuente única + fecha de actualización |
| WhatsApp fuera de 24h | plantillas y follow-up (4D) |
| Sesgo automotriz en el core | revisión de imports y tests de frontera |
