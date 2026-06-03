# Izas Chatbot — Checklist de despliegue y pruebas

Guía para poner en producción los cambios de backend, script de Shopify y visualizador.

## 0. Antes de empezar (Supabase)

- [ ] Abre **Supabase → SQL Editor** y ejecuta `SUPABASE_SETUP.sql`. Crea la tabla `ai_index` y activa RLS.
- [ ] Decide la política de lectura del visualizador (Opción A autenticada — recomendada — u Opción B anon) y descomenta la que elijas en ese SQL.
- [ ] **Importante:** confirma que la variable `SUPABASE_KEY` del **backend** es la **service_role key** (no la anon). El backend necesita saltarse el RLS para leer/escribir. La anon key es solo para el visualizador.

## 1. Backend (Render)

Variables de entorno (Render → Environment):

- [ ] `OPENAI_API_KEY` — (ya la tenías)
- [ ] `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN` — (ya las tenías)
- [ ] `SUPABASE_URL`, `SUPABASE_KEY` — usar **service_role** key
- [ ] `ALLOWED_ORIGINS` = `https://www.izas-outdoor.com,https://izas-outdoor.com` (CORS)
- [ ] `ADMIN_TOKEN` = una cadena secreta larga (para `/api/admin/reindex`)
- [ ] *(opcional)* `SHOPIFY_API_VERSION`, `LIVE_STOCK_TTL_MS`, `DEBUG=false`
- [ ] *(opcional)* `SYNC_INTERVAL_MS` — cada cuánto se sincroniza el catálogo automáticamente (por defecto 6h = `21600000`)

Pasos:

- [ ] Sube el `server.js` actualizado y haz deploy.
- [ ] Comprueba el arranque: visita `https://<tu-backend>/health` → debe responder `{ "status": "ok", "productsIndexed": N, ... }`.
- [ ] La **primera** vez indexará desde Shopify (tarda) y guardará en Supabase. Los siguientes arranques cargarán desde Supabase sin re-vectorizar (mira los logs: "Índice cargado desde Supabase").

## 2. Script de Shopify (theme)

- [ ] Sustituye el contenido del script antiguo por `izas-chatbot-frontend.js`.
- [ ] Verifica que `BACKEND_URL` apunta a tu backend de Render.
- [ ] No hace falta tocar el HTML: usa los mismos IDs de siempre.

## 3. Visualizador

- [ ] Crea un archivo `.env` en la raíz con:
  - `VITE_SUPABASE_URL=...`
  - `VITE_SUPABASE_ANON_KEY=...` (la **anon**, no la service_role)
- [ ] `npm install && npm run build`
- [ ] Despliega (Netlify/Vercel/Render Static) o `npm run dev` para uso local.

## 4. Ronda de pruebas (web real)

Abre la tienda y el chat, y comprueba con la consola del navegador abierta:

- [ ] **Saludo**: escribe "hola" → responde rápido (atajo small talk, sin tarjetas).
- [ ] **Búsqueda**: "chaquetas impermeables" → aparecen tarjetas de producto con imagen y precio.
- [ ] **Contexto de producto**: entra en una página de producto y pregunta "¿qué tallas hay?" → responde sobre ESE producto y aparece en el panel lateral.
- [ ] **Pedido**: "estado de mi pedido 12345" → pide el email; al darlo, devuelve el estado (o aviso de seguridad si no coincide).
- [ ] **Enlaces**: que los links de la respuesta sean clicables.
- [ ] **Panel lateral / historial** de productos vistos funciona en escritorio y móvil.
- [ ] **Sin errores** rojos en consola.

## 5. Visualizador — pruebas

- [ ] Carga la lista de chats (spinner → lista).
- [ ] Los filtros (buscador, fecha, categoría) funcionan y el término se resalta.
- [ ] Las estadísticas (chats, hoy, derivaciones) cuadran.
- [ ] Al abrir un chat, los mensajes se ven formateados (negritas/enlaces) y sin el ruido `[CONTEXTO SISTEMA...]`.
- [ ] Si quitas las variables de entorno, sale el mensaje de error claro (no pantalla en blanco).

## 6. Productos nuevos: sincronización AUTOMÁTICA

Ya **no hace falta reindexar a mano**. El backend sincroniza el catálogo solo:

- A los ~2 minutos de arrancar.
- Cada `SYNC_INTERVAL_MS` (por defecto 6h) de forma indefinida.

La sincronización es **incremental**: solo vectoriza productos **nuevos o cambiados**
(detecta cambios por hash) y elimina los borrados. Reutiliza los embeddings de lo que
no cambió, así que es barata aunque tengas muchos productos.

### Forzar manualmente (opcional)

Si quieres que un producto nuevo aparezca al instante sin esperar al ciclo:

```bash
curl -X POST https://<tu-backend>/api/admin/reindex \
  -H "x-admin-token: TU_ADMIN_TOKEN"
```

(Esto hace una reconstrucción completa. Para el día a día no es necesario.)
