# 🏛️ Reglas de Arquitectura — Chatbot WS

> **Obligatorio para humanos y agentes.** El Quality Gate falla si se viola el presupuesto de líneas.
> Este documento manda sobre la comodidad de “meter la lógica donde ya estaba”.

---

## 1. Presupuesto de tamaño (ejecutable)

| Regla | Límite |
| :--- | ---: |
| Archivo **nuevo** en `src/` | **400 líneas** |
| Archivo existente con cap legacy | Su cap en `architecture-baseline.json` |
| Función | 80 líneas (revisión; extraer si supera) |
| Parámetros de una función | 5 (usar objeto si supera) |
| Anidamiento | 4 niveles |

`architecture-baseline.json` es una **ratchet**:

- Solo contiene archivos legacy que ya superan 400 líneas.
- Su número **solo puede bajar**, nunca subir.
- Si refactorizas un archivo por debajo de su cap, actualiza el JSON a la baja.
- Si el archivo baja de 400, elimina su entrada.
- Un archivo nuevo **no puede** entrar al baseline. Si necesita más de 400 líneas, está mal diseñado.

El checker está en `scripts/tools/checkArchitecture.ts` y corre dentro de `npm run quality-gate`.

---

## 2. Capas y dependencias permitidas

```text
controllers → services / harness
services    → repositories / providers / core
harness     → core / providers (contratos) / repositories
repositories→ providers/database
providers   → APIs externas, SDKs, DB
core        → tipos y contratos; SIN canales ni SDKs
packs       → configuración y tools de un rubro
```

### Prohibiciones duras

1. **SQL fuera de `repositories/`.** Si un servicio arma `SELECT`, está mal.
2. **SDK de canal fuera de `providers/channels/`.** El núcleo solo ve `ChannelAdapter` / `ChannelSender`.
3. **`if (channel === 'whatsapp')` en `harness/`, `services/` o `core/`.** Se resuelve por registry/polimorfismo.
4. **Lógica de negocio en controllers.** El controller valida, traduce HTTP y delega.
5. **Un archivo nuevo >400 líneas.** Se parte por responsabilidad.
6. **Prompts o tools de un rubro en `core/`.** Van en `packs/<rubro>/` o en el registry del pack.
7. **Estado global mutable nuevo** sin justificación y test de aislamiento.

---

## 3. Cuándo extraer

Extrae **antes** de agregar, si tu cambio va a:

- superar el cap del archivo;
- añadir una segunda responsabilidad (ej. enviar + alertar + persistir);
- añadir un `if` de canal, proveedor o rubro;
- requerir más de 3 dependencias nuevas.

### Patrón de extracción

1. Identifica una responsabilidad con nombre claro (`BacklogMonitor`, `QuotaService`, `MediaStorage`).
2. Muévela a un módulo con dependencias inyectadas o imports explícitos.
3. Deja el orquestador con una llamada fina.
4. Añade tests del módulo extraído.
5. Baja el cap del baseline si corresponde.

---

## 4. Definition of Done arquitectónica

Antes de commit:

- [ ] `npm run quality-gate` pasa 4/4 (incluye presupuesto).
- [ ] Ningún archivo nuevo >400 líneas.
- [ ] Ningún cap legacy subió.
- [ ] No hay SQL fuera de repositorios.
- [ ] No hay SDK de canal en el núcleo.
- [ ] No hay lógica de rubro en `core/`.
- [ ] El cambio tiene tests de comportamiento, no solo de tipo.
- [ ] Si extrajiste un módulo, el orquestador quedó más pequeño.

---

## 5. Deuda actual (ratchet)

Los archivos legacy con cap viven en `architecture-baseline.json`. El plan de reducción está en
[`docs/architecture/DEUDA_MONOLITOS.md`](docs/architecture/DEUDA_MONOLITOS.md).

**Regla cultural:** si tocas un archivo del baseline, no lo hagas crecer. Si puedes, bájalo.
