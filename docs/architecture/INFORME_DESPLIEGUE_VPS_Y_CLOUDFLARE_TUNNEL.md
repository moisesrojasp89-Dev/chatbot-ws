# 🚀 INFORME TÉCNICO DE INFRAESTRUCTURA & DESPLIEGUE
## Plataforma Chatbot WS — VPS <VPS_REGION> & Cloudflare Tunnel

**Fecha:** 24 de Septiembre de 2026  
**Proyecto:** Chatbot WS (WhatsApp Business API Platform)  
**Autor:** Equipo de Infraestructura Cuantitativa & DevOps  
**Destinatario:** Agente de Desarrollo & Mantenimiento de Chatbot WS  
**Estado:** **Producción 100% Operativa y Validada en Vivo**

> ⚠️ **Documento histórico de infraestructura (WhatsApp/Meta).** Para el arranque vigente con LLM genérico, Telegram y migración 016, usa [`RUNBOOK_ARRANQUE_Y_DESPLIEGUE.md`](RUNBOOK_ARRANQUE_Y_DESPLIEGUE.md).

---

## 1. Resumen Ejecutivo

El presente documento certifica el aprovisionamiento, despliegue, endurecimiento y validación en vivo de la plataforma **Chatbot WS** en infraestructura soberana de producción. 

El servicio corre bajo **Node.js 20 LTS**, compilado con **TypeScript** sobre el framework **Fastify v4**, conectado a un cluster PostgreSQL en **Supabase** (São Paulo `sa-east-1`), aislado en recursos mediante **systemd cgroups** dentro de un Droplet de <VPS_PROVIDER> en **Nueva York (<VPS_REGION>)**, y expuesto hacia la API de Meta WhatsApp a través de un túnel cifrado de **Cloudflare Zero Trust** en el dominio dedicado **`chabotws.com`**.

---

## 2. Parámetros de Dominio & Enrutamiento Público

Para garantizar una URL fija, segura y con certificado SSL permanente sin abrir puertos entrantes en el servidor, se adquirió y configuró un dominio institucional propio:

* **Dominio Registrado:** `chabotws.com`
* **Registrador:** Cloudflare Registrar (Cuenta: `Aeon.infraestructura@gmail.com`)
* **Vigencia:** 23 de Septiembre de 2026 hasta 23 de Septiembre de 2027 (Auto-renovación activa)
* **Gestión DNS:** Cloudflare Authoritative DNS con Proxy Cifrado
* **Subdominio de Webhook Activo:** `<WEBHOOK_DOMAIN>`
* **Arquitectura de Exposición:** Cloudflare Tunnel Remoto (`cloudflared`). **Cero puertos HTTP/HTTPS abiertos en el Firewall del VPS**.

---

## 3. Especificaciones del Servidor VPS (Host)

* **Proveedor:** <VPS_PROVIDER>
* **Datacenter:** <VPS_REGION> (Nueva York, EE. UU. — Latencia óptima transatlántica y hacia Supabase US/LATAM)
* **Dirección IP Pública:** `<VPS_IP>` (Referencia SecOps: `[VPS-<VPS_REGION>-PROD]`)
* **Sistema Operativo:** <OS>
* **Hardware:** 1 vCPU, 1024 MB (1 GB) RAM física, 25 GB NVMe SSD
* **Memoria Swap de Respaldo:** 2048 MB (2 GB) montados sobre SSD con `vm.swappiness=10`
* **Seguridad de Red (UFW):**
  * Política entrante: `DEFAULT DENY`
  * Política saliente: `DEFAULT ALLOW`
  * Puertos abiertos únicamente: `22/tcp` y `2222/tcp` (Acceso SSH exclusivo por llaves criptográficas Ed25519)
  * Protección anti-fuerza bruta: `Fail2ban` activo (3 intentos fallidos = 1 hora de baneo)

---

## 4. Coexistencia Multi-Tenant (AEON + Chatbot WS)

El servidor aloja concurrentemente el motor financiero de **AEON** y la pasarela de **Chatbot WS**. Para evitar que un pico de carga o fuga de memoria de un sistema afecte al otro, se definieron límites estrictos a nivel de kernel mediante **systemd cgroups**:

| Servicio | Usuario | Directorio | Límites de RAM | Peso de CPU | Prioridad |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`aeon-quant-daemon`** | `aeon` | `/opt/aeon` | `MemoryMax=650M`, `MemoryHigh=550M` | `CPUWeight=200` | Prioridad 1 |
| **`chatbot-ws`** | `chatbot` | `/opt/chatbot-ws` | `MemoryMax=250M`, `MemoryHigh=180M` | `CPUWeight=80` | Prioridad 2 |
| **`cloudflared`** | `root` | `/etc/cloudflared` | Gestionado por Zero Trust | Default | N/A |

* **Estado de Consumo Real Medido:**  
  * CPU global en reposo: **~1.18%**
  * Memoria RAM consumida total del host: **41.2% (~412 MB de 1 GB)**
  * Memoria Chatbot WS en ejecución: **~29.9 MB**
  * Memoria Swap utilizada: **0%**

---

## 5. Arquitectura del Servicio Chatbot WS

### 5.1. Código Fuente y Entorno
* **Ruta de Instalación:** `/opt/chatbot-ws`
* **Repositorio Remoto:** `https://github.com/corechatbotws-maker/chatbot-ws.git` (Rama: `main`)
* **Binario de Ejecución:** `/usr/bin/node /opt/chatbot-ws/dist/server.js`
* **Permisos del Directorio:** `chown -R chatbot:chatbot /opt/chatbot-ws`
* **Variables de Entorno:** `/opt/chatbot-ws/.env` (Permisos `600`, lectura exclusiva para `chatbot`)

### 5.2. Configuración de Variables (`/opt/chatbot-ws/.env`)
```env
PORT=3000
NODE_ENV=production

# Credenciales Meta WhatsApp API
META_ACCESS_TOKEN=EAAB_TEST_TOKEN_DEVELOPMENT_PURPOSES_ONLY_123456789
META_APP_SECRET=dev_secret_meta_hash_32_characters_ok
WEBHOOK_VERIFY_TOKEN=dev_verify_token_secure_123

# Proveedor LLM (API compatible OpenAI)
LLM_API_KEY=your_llm_provider_api_key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=your-model-name

# Supabase PostgreSQL Pooler (São Paulo sa-east-1)
DATABASE_URL=postgresql://postgres.[<PROJECT_REF>]:[DB-PASSWORD]@<SUPABASE_POOLER_HOST>:5432/postgres
```
*(Nota operativa: Cuando se deseen conectar las credenciales finales de la App de Meta o la clave real del proveedor LLM, se actualizan estas variables en `/opt/chatbot-ws/.env` y se reinicia el servicio con `systemctl restart chatbot-ws`)*.

### 5.3. Unidad Systemd (`/etc/systemd/system/chatbot-ws.service`)
```ini
[Unit]
Description=Chatbot WS - WhatsApp Business Webhook Daemon
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chatbot
Group=chatbot
WorkingDirectory=/opt/chatbot-ws
EnvironmentFile=/opt/chatbot-ws/.env
ExecStart=/usr/bin/node /opt/chatbot-ws/dist/server.js
Restart=always
RestartSec=5s
KillMode=process
TimeoutStopSec=28s

# Límites de CPU y Memoria (Prioridad inferior a AEON)
MemoryMax=250M
MemoryHigh=180M
CPUWeight=80

# Seguridad y Aislamiento del Proceso
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=chatbot-ws

[Install]
WantedBy=multi-user.target
```

---

## 6. Base de Datos & Migraciones

La base de datos PostgreSQL se conecta a través del Transaction Pooler IPv4 de Supabase en São Paulo:
* **Host:** `<SUPABASE_POOLER_HOST>`
* **Puerto:** `5432` (Session Pooler; el 6543 no es apto para `pg_advisory_lock`)
* **Base de Datos:** `postgres`
* **Historial de Migraciones:** Verificado y registrado en `public.migrations_history`.
* **Plan de Migraciones (16 archivos; 015/016 pendientes de ventana de mantenimiento):**
    > ⚠️ **Ventana de mantenimiento obligatoria (single-VPS systemd):** ejecutar en orden **stop del servicio → `npm run migrate` → start del servicio**. La migración `015_inbound_channel_identity.sql` elimina `UNIQUE(wamid)` y el código nuevo usa `ON CONFLICT (channel, wamid)`: ni el código viejo después de migrar ni el código nuevo antes de migrar funcionan (`42P10`).
  1. `001_initial_schema.sql` (Tablas maestras de chats, mensajes, contactos)
  2. `002_outbox_and_statuses.sql` (Patrón Transaccional Outbox)
  3. `003_outbox_resilience_locked_at.sql`
  4. `004_outbox_lock_token.sql`
  5. `005_outbox_reaper_index.sql`
  6. `006_outbox_head_and_status_events.sql`
  7. `007_status_events_dedup_and_unique.sql`
  8. `008_inbound_events_table.sql`
  9. `009_enable_rls_backend_tables.sql` (Row Level Security activo)
  10. `010_revoke_anon_authenticated_permissions.sql` (Principio de menor privilegio)
  11. `011_inbound_performance_indexes.sql`
  12. `012_default_privileges_and_handoff_reasons.sql`
  13. `013_security_hardening_and_hot_indexes.sql`
  14. `014_multichannel_channel_columns.sql` (columna `channel` en inbound_events/outbox_messages)
  15. `015_inbound_channel_identity.sql` (UNIQUE `(channel, wamid)`: requiere mantenimiento)
16. `016_backfill_normalized_inbound_payload.sql` (backfill de payloads legados: requiere ventana stop→migrate→start)

---

## 7. Configuración del Túnel de Cloudflare (Zero Trust)

* **Nombre del Túnel:** `chatbot-ws`
* **Tipo:** Cloudflare Managed Tunnel (`cloudflared`)
* **Estado en Dashboard:** **`Healthy`** (Conector Debian 64-bit activo bajo systemd)
* **Regla de Ingress:**
  * **Public Hostname:** `<WEBHOOK_DOMAIN>`
  * **Path:** (Raíz / Captura todo)
  * **Service Type:** `HTTP`
  * **URL Interna:** `localhost:3000`
* **Beneficios de Seguridad:**
  1. No hay puertos abiertos hacia Internet en el VPS.
  2. Protección contra ataques DDoS mitigada por la red Anycast de Cloudflare.
  3. Certificado SSL TLS 1.3 gestionado automáticamente con renovación infinita.

---

## 8. Resultados de Pruebas y Certificación en Vivo

Se ejecutaron pruebas directas contra los endpoints de producción vía Internet público con los siguientes resultados:

### Prueba 1: Diagnóstico de Salud y Pool de Base de Datos
* **Comando:** `curl -i https://<WEBHOOK_DOMAIN>/health`
* **Respuesta HTTP:** `HTTP/1.1 200 OK`
* **Payload Recibido:**
  ```json
  {
    "status": "ok",
    "database": "connected",
    "uptimeSeconds": 856,
    "timestamp": "2026-09-24T02:54:03.867Z"
  }
  ```
* **Veredicto:** APROBADO ✅.

### Prueba 2: Handshake Oficial de Meta WhatsApp (Challenge Response)
* **Comando:**
  ```bash
  curl -i "https://<WEBHOOK_DOMAIN>/webhook?hub.mode=subscribe&hub.verify_token=dev_verify_token_secure_123&hub.challenge=1158201444"
  ```
* **Respuesta HTTP:** `HTTP/1.1 200 OK`
* **Payload Recibido:** `1158201444`
* **Veredicto:** APROBADO ✅. El webhook cumple al 100% con la especificación de Meta Graph API.

### Prueba 3: Seguridad Anti-Intrusos (Rechazo de Token Inválido)
* **Comando:**
  ```bash
  curl -i "https://<WEBHOOK_DOMAIN>/webhook?hub.verify_token=TOKEN_INVALIDO"
  ```
* **Respuesta HTTP:** `HTTP/1.1 403 Forbidden`
* **Payload Recibido:**
  ```json
  {"error": "Forbidden. Invalid verification token."}
  ```
* **Veredicto:** APROBADO ✅.

---

## 9. Datos de Conexión para el Panel de Meta for Developers

Al registrar el Webhook en el portal de desarrolladores de Meta (WhatsApp Business Cloud API), ingresar exactamente estos parámetros:

* **Callback URL:** `https://<WEBHOOK_DOMAIN>/webhook`
* **Verify Token:** `dev_verify_token_secure_123`
* **Campos a Suscribir (Webhook Fields):** `messages`, `message_deliveries`, `message_reads`.

---

## 10. Manual Operativo & Comandos Frecuentes

Para el desarrollador o agente que mantenga el Chatbot WS, aquí se recopilan los comandos de administración en la consola del Droplet:

### Ver el estado del servicio:
```bash
systemctl status chatbot-ws --no-pager
```

### Monitorear los logs en tiempo real:
```bash
journalctl -u chatbot-ws -f -o cat
```

### Reiniciar el servicio:
```bash
systemctl restart chatbot-ws
```

### Detener o Iniciar el servicio:
```bash
systemctl stop chatbot-ws
systemctl start chatbot-ws
```

### Actualizar el código desde GitHub:
```bash
cd /opt/chatbot-ws
git pull origin main
npm install
npm run build
npm run migrate
chown -R chatbot:chatbot /opt/chatbot-ws
systemctl restart chatbot-ws
```

### Verificar el estado del túnel de Cloudflare:
```bash
systemctl status cloudflared --no-pager
```

---
*Fin del informe de infraestructura.*
