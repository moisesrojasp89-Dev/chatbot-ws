# ☁️ Bitácora Técnica: Infraestructura, Servidor Fastify & Despliegue

> **Dominio:** Servidor Web, Ciclo de Vida, Observabilidad, Despliegue en VPS <VPS_PROVIDER>, Túneles Cloudflare y Systemd.

---

## 🚀 Evolución y Decisiones Clave por Fase

### 1. Servidor Web Fastify 4 (Fase 1 y 5A)
* **Arquitectura No Bloqueante:**
  * Uso de Fastify 4 por su bajo overhead de event-loop, permitiendo procesar cientos de webhooks por segundo en recursos mínimos de CPU.
* **Manejo Estricto de Señales de Apagado (Graceful Shutdown):**
  * Manejo coordinado de `SIGTERM` y `SIGINT`.
  * Presupuesto de apagado acotado (`shutdownBudgetMs` ~25s): los dispatchers de Outbox e Inbound pausan el sondeo, completan las tareas y peticiones en vuelo, y liberan los recursos de base de datos antes de salir.
* **Probes de Salud y Readiness:**
  * `GET /health`: Liveness probe que verifica que el proceso está activo y respondiendo.
  * `GET /ready`: Readiness probe que valida conectividad activa con PostgreSQL antes de dirigir tráfico entrante de webhooks.

### 2. Observabilidad y Logging Forense (Pino)
* **Logger Estructurado JSON:**
  * Uso de `pino` para logging de alta velocidad en producción con salida en JSON estructurado.
  * Enmascaramiento automático de números de teléfono y tokens para proteger datos PII en logs.
  * Nivel configurable vía variable de entorno `LOG_LEVEL` (`debug`, `info`, `warn`, `error`).

### 3. Infraestructura de Producción (VPS + Cloudflare Tunnel)
* **Despliegue en <VPS_PROVIDER> Droplet (<VPS_REGION>):**
  * Node.js LTS en Ubuntu Server 22.04 LTS gestionado bajo servicio `systemd` para auto-rearranque en fallos (`Restart=always`).
* **Cloudflare Tunnels (`cloudflared`):**
  * Cero puertos abiertos al público en el firewall del servidor (cero exposición directa del puerto 3000).
  * Enrutamiento seguro y cifrado TLS/SSL gestionado automáticamente por la red de borde de Cloudflare con protección DDoS nativa.
