/* ==========================================================================
   🚀 SERVIDOR IZAS OUTDOOR CHATBOT - VERSIÓN MAESTRA FINAL (FIXED)
   ==========================================================================
   Este servidor actúa como el "Cerebro Central".
   - Conecta con Shopify (Catálogo, Pedidos y Stock en Tiempo Real).
   - Conecta con OpenAI (Inteligencia y RAG).
   - Conecta con Supabase (Memoria a largo plazo).
   
   CORRECCIONES V3:
   - Fix Crítico en getLiveStockForProducts (No borra precios/imágenes).
   - Traducción forzada de Tallas (XXL -> 2XL).
   - Prompt anti-alucinaciones de stock.
   - Formato Extendido y Legible.

   CORRECCIONES V4 (seguridad y robustez):
   - Nuevo endpoint /api/chat/init (el frontend lo necesitaba).
   - CORS restringido a dominios propios + rate limiting por IP.
   - Límite de longitud en la query (anti-abuso/coste).
   - Timeout real en Shopify vía AbortController.
   - refineQuery protegido con try/catch (no tumba el endpoint).
   ========================================================================== */

import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from "fs";
import crypto from "crypto";
import cors from "cors";
import { COLOR_CONCEPTS, CONCEPTS } from "./concepts.js"; // Diccionarios de sinónimos
import { createClient } from "@supabase/supabase-js";

/* --- 🏢 INFORMACIÓN DE MARCA (CONTEXTO FIJO) --- */
const BRAND_INFO = `
SOBRE IZAS OUTDOOR:
Somos una marca especializada en ropa de montaña, trekking y outdoor.
Nuestra filosofía es ofrecer la máxima calidad y tecnología a precios accesibles.

TECNOLOGÍAS CLAVE:
- Mount-Loft: Fibras ultraligeras con propiedades térmicas similares a la pluma, pero resistentes al agua.
- AWPS (All Weather Protection System): Membranas cortavientos e impermeables transpirables.
- Dry: Tejidos que expulsan el sudor y secan rápido.
- Softshell: Tejido tricapa que combina capa exterior repelente, membrana cortavientos e interior térmico.

DISTRIBUCIÓN Y VENTA:
- Vendemos principalmente en nuestra web oficial (donde está todo el catálogo y mejores ofertas).
- También tenemos presencia en Marketplaces como Decathlon, Amazon, Sprinter y El Corte Inglés.
- Tiendas físicas propias y distribuidores autorizados.

CALIDAD:
Usamos costuras termoselladas en prendas impermeables y patrones ergonómicos para la libertad de movimiento.
`;

/* --- ⚙️ CONFIGURACIÓN DEL SERVIDOR --- */
const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* --- 🔒 CORS RESTRINGIDO ---
   Solo permitimos peticiones desde nuestros propios dominios.
   Puedes añadir o quitar orígenes en la variable de entorno ALLOWED_ORIGINS
   (separados por comas). Si no existe, usamos los valores por defecto. */
const DEFAULT_ORIGINS = [
    "https://www.izas-outdoor.com",
    "https://izas-outdoor.com",
    "https://izas-outdoor.myshopify.com"
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
    : DEFAULT_ORIGINS);

app.use(cors({
    origin: (origin, callback) => {
        // Permitimos peticiones sin origin (apps móviles, curl, healthchecks)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        console.warn(`⛔ CORS bloqueado para origen: ${origin}`);
        return callback(new Error("Origen no permitido por CORS"));
    }
}));
app.use(express.json({ limit: "100kb" })); // Permite recibir datos JSON (con límite de tamaño)

/* --- 🚦 RATE LIMITING (sin dependencias) ---
   Limita el número de peticiones por IP en una ventana de tiempo.
   Evita que alguien abuse del endpoint y dispare costes de OpenAI. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 20;              // 20 peticiones por minuto por IP
const rateBuckets = new Map();          // ip -> { count, resetAt }

function rateLimiter(req, res, next) {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "desconocida")
        .toString().split(",")[0].trim();
    const now = Date.now();
    let bucket = rateBuckets.get(ip);

    if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        rateBuckets.set(ip, bucket);
    }

    bucket.count++;
    if (bucket.count > RATE_LIMIT_MAX) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({ error: "Demasiadas peticiones. Inténtalo en unos segundos." });
    }
    next();
}

// Limpieza periódica de buckets viejos para no acumular memoria
setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
        if (now > bucket.resetAt) rateBuckets.delete(ip);
    }
}, 5 * 60 * 1000);

// Credenciales Shopify
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Credenciales OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🐞 Modo depuración: si DEBUG !== "true", silenciamos los logs ruidosos.
const DEBUG = process.env.DEBUG === "true";
const debugLog = (...args) => { if (DEBUG) console.log(...args); };

// 🛍️ Versión de la API de Shopify (configurable por env para no quedar obsoleta).
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";


/* ==========================================================================
   🛠️ HELPERS (HERRAMIENTAS DE AYUDA)
   ========================================================================== */

// Busca si una palabra está dentro de una frase (match exacto)
function includesWord(q, word) {
    const w = ` ${word.toLowerCase()} `;
    return q.includes(w);
}

// Genera variantes gramaticales de colores (Rojo -> Rojas, Rojos...)
function colorVariants(base) {
    const variants = [base];
    if (base.endsWith("o")) {
        variants.push(base.replace(/o$/, "a"));
        variants.push(base + "s");
        variants.push(base.replace(/o$/, "os"));
        variants.push(base.replace(/o$/, "as"));
    } else if (base.endsWith("z")) {
        variants.push(base.replace(/z$/, "ces"));
    } else if (/[aeiouáéíóú]$/i.test(base)) {
        variants.push(base + "s");
    } else {
        variants.push(base + "es");
    }
    return variants.filter(Boolean);
}

// Normaliza la búsqueda del usuario (traduce "chupa" a "chaqueta", etc.)
function normalizeQuery(query) {
    let q = ` ${query.toLowerCase()} `;

    // 1. Expansión de Conceptos (Sinónimos)
    Object.values(CONCEPTS).forEach(concept => {
        for (const match of concept.matches) {
            if (includesWord(q, match)) {
                q += ` ${concept.canonical}`;
                break;
            }
        }
        if (includesWord(q, concept.canonical)) {
            q += " " + concept.matches.join(" ");
        }
    });

    // 2. Expansión de Colores
    Object.values(COLOR_CONCEPTS).forEach(color => {
        const variants = colorVariants(color.canonical);
        if (variants.some(v => includesWord(q, v))) {
            q += " " + color.matches.join(" ") + " ";
        }
    });

    // 3. 🔥 MEJORA TALLAS: Normalización XXL <-> 2XL
    // Esto es clave para que Shopify encuentre la talla aunque el usuario la escriba diferente
    q = q.replace(/\b(xxl|xxxl|xxxxl)\b/gi, match => {
        const m = match.toLowerCase();
        if (m === 'xxl') return '2xl';
        if (m === 'xxxl') return '3xl';
        if (m === 'xxxxl') return '4xl';
        return match;
    });

    return q;
}

// Limpia texto HTML sucio que viene de Shopify
function cleanText(text) {
    if (!text) return "";
    // 1. Reemplazamos <br> por saltos de línea reales para que la IA entienda la estructura
    let clean = text.replace(/<br\s*\/?>/gi, "\n"); 
    // 2. Quitamos el resto de etiquetas HTML
    clean = clean.replace(/<[^>]*>?/gm, " ");
    // 3. Quitamos espacios dobles
    clean = clean.replace(/\s+/g, " ").trim();
    // 🔥 SUBIMOS EL LÍMITE A 5000 (O lo quitamos directamente)
    return clean.substring(0, 5000); 
}

// Cálculo matemático para ver similitud entre vectores (Búsqueda Semántica)
function cosineSimilarity(a, b) {
    return a.reduce((acc, val, i) => acc + val * b[i], 0);
}

// Parsea JSON de forma segura
function safeParse(value) {
    try { return JSON.parse(value); } catch { return value; }
}

// 👋 Detecta saludos / charla trivial para ahorrarnos 3 llamadas a OpenAI.
// Conservador: solo corta si TODO el mensaje es un saludo corto sin intención de producto.
const SMALLTALK_PATTERNS = [
    /^hola+$/, /^buenas( tardes| noches| dias| días)?$/, /^hey$/, /^holi+$/,
    /^gracias( muchas)?$/, /^muchas gracias$/, /^ok(ay)?$/, /^vale$/, /^genial$/,
    /^perfecto$/, /^adios$/, /^adiós$/, /^hasta luego$/, /^buenos dias$/, /^buenos días$/
];
function isSmallTalk(text) {
    const t = (text || "").toLowerCase().trim().replace(/[!¡.,…]+$/g, "").replace(/\s+/g, " ");
    if (t.length === 0 || t.length > 25) return false;
    // Si menciona algo que parece producto/pedido, NO es small talk
    if (/\d{3,}|@|talla|precio|envio|envío|pedido|devol|cambio|stock|chaqueta|pantalon|comprar/.test(t)) return false;
    return SMALLTALK_PATTERNS.some(re => re.test(t));
}
function smallTalkReply(text) {
    const t = (text || "").toLowerCase();
    if (/gracias/.test(t)) return "¡A ti! 🏔️ Si necesitas algo más (productos, tallas, envíos o tu pedido), aquí estoy.";
    if (/adios|adiós|hasta luego/.test(t)) return "¡Hasta pronto! Que disfrutes la montaña. 🏔️";
    return "¡Hola! 👋 ¿En qué puedo ayudarte? Puedo buscarte productos, resolver dudas de tallas, envíos o devoluciones, o consultar tu pedido.";
}

// Extractor robusto de JSON (para cuando GPT mete texto antes o después)
function extractJSON(str) {
    const first = str.indexOf('{');
    const last = str.lastIndexOf('}');
    if (first !== -1 && last !== -1) {
        return JSON.parse(str.substring(first, last + 1));
    }
    return JSON.parse(str);
}


/* ==========================================================================
   🛍️ CONEXIÓN CON SHOPIFY (GRAPHQL) - CON SISTEMA ANTICAÍDAS
   ========================================================================== */

// 🔥 FUNCIÓN MEJORADA: Incluye sistema de reintentos (Retries)
async function fetchGraphQL(query, variables = {}, retries = 3) {
    const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    
    for (let i = 0; i < retries; i++) {
        // 🔥 FIX: node-fetch v3 ignora la opción 'timeout'. Usamos AbortController
        // para cortar de verdad las peticiones que se cuelgan (10s máximo).
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "X-Shopify-Access-Token": ADMIN_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query, variables }),
                signal: controller.signal // 10 segundos máximo por petición
            });

            if (!res.ok) {
                throw new Error(`Shopify Error ${res.status}: ${res.statusText}`);
            }

            const json = await res.json();
            if (json.errors) console.error("❌ GraphQL Error:", json.errors);
            return json.data;

        } catch (error) {
            // Si es el último intento, fallamos de verdad
            if (i === retries - 1) {
                console.error(`❌ Fallo definitivo tras ${retries} intentos:`, error.message);
                throw error;
            }
            
            // Si no, esperamos un poco y reintentamos (Backoff exponencial)
            const waitTime = 1000 * (i + 1); // 1s, 2s, 3s...
            console.warn(`⚠️ Error red (${error.message}). Reintentando en ${waitTime}ms... (${i + 1}/${retries})`);
            await new Promise(r => setTimeout(r, waitTime));
        } finally {
            clearTimeout(timeoutId); // Evitamos fugas de timers
        }
    }
}

// 📦 RECUPERADOR DE PRODUCTOS: Descarga todo el catálogo para estudiarlo
async function getAllProducts() {
    let hasNextPage = true;
    let cursor = null;
    const products = [];

    // Consulta gigante para traer todo: Info, variantes, stock, precios, opciones...
    const query = `
    query getProducts($cursor: String) {
      products(first: 30, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id title description productType tags handle
            images(first: 1) { edges { node { url } } }
            descriptionHtml 
            options { name values }
            # DATOS DE STOCK
            variants(first: 100) {
              edges {
                node {
                  id title price availableForSale inventoryQuantity
                  selectedOptions { name value }
                }
              }
            }
            metafields(first: 40) { edges { node { namespace key value } } }
          }
        }
      }
    }
    `;

    try {
        while (hasNextPage) {
            const data = await fetchGraphQL(query, { cursor });
            if (!data || !data.products) {
                console.error("❌ Error recuperando página de productos. Saltando...");
                break;
            }

            const edges = data.products.edges;

            edges.forEach(({ node }) => {
                const cleanId = node.id.split("/").pop(); // Limpia el ID

                // Procesamos las variantes para guardarlas limpias
                const variantsClean = node.variants.edges.map(v => ({
                    id: (v.node.id || "").split("/").pop(),
                    title: v.node.title,
                    price: v.node.price,
                    image: v.node.image?.url || "",
                    availableForSale: v.node.availableForSale,
                    inventoryQuantity: v.node.inventoryQuantity,
                    selectedOptions: v.node.selectedOptions
                }));

                products.push({
                    id: cleanId,
                    title: node.title,
                    handle: node.handle,
                    description: node.description,
                    body_html: node.descriptionHtml,
                    productType: node.productType,
                    price: node.variants.edges[0]?.node.price || "Consultar",
                    tags: node.tags,
                    image: node.images.edges[0]?.node.url || "",
                    options: node.options.map(o => ({ name: o.name, values: o.values })),
                    variants: variantsClean,
                    metafields: Object.fromEntries(
                        node.metafields.edges.map(m => [`${m.node.namespace}.${m.node.key}`, safeParse(m.node.value)])
                    ),
                });
            });

            hasNextPage = data.products.pageInfo.hasNextPage;
            if (hasNextPage) cursor = edges[edges.length - 1].cursor;
            
            // Pequeña pausa para no saturar la API
            // await new Promise(r => setTimeout(r, 200)); 
        }
    } catch (e) {
        console.error("⚠️ Error durante getAllProducts (Carga parcial):", e.message);
    }
    return products;
}

// ⚡ LIVE STOCK CHECK: Actualiza el stock de productos específicos en tiempo real
// 🗃️ CACHE DE STOCK EN VIVO (TTL corto)
// Evita preguntar a Shopify por el mismo producto en cada mensaje.
// id -> { variants (solo datos de stock), ts }
const liveStockCache = new Map();
const LIVE_STOCK_TTL_MS = Number(process.env.LIVE_STOCK_TTL_MS) || 60 * 1000; // 60s por defecto

// 🔥 FIX CRÍTICO: Mantiene precios e imágenes si el check rápido no los trae
async function getLiveStockForProducts(products) {
    if (!products || products.length === 0) return products;

    const now = Date.now();

    // Separamos lo que tenemos fresco en cache de lo que hay que pedir a Shopify
    const staleProducts = products.filter(p => {
        const cached = liveStockCache.get(String(p.id));
        return !cached || (now - cached.ts) > LIVE_STOCK_TTL_MS;
    });

    debugLog(`⚡ Stock: ${products.length} pedidos, ${staleProducts.length} a Shopify (resto cache).`);

    // Si TODO está fresco en cache, no llamamos a Shopify
    if (staleProducts.length === 0) {
        return products.map(p => applyCachedStock(p));
    }

    // Preparamos los IDs SOLO de los productos caducados
    const productIds = staleProducts.map(p => `gid://shopify/Product/${p.id}`);

    const query = `
    query getNodes($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          variants(first: 100) {
            edges {
              node {
                id
                title
                inventoryQuantity
                availableForSale
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
    `;

    try {
        const data = await fetchGraphQL(query, { ids: productIds });

        // Guardamos en cache los nodos frescos que sí han llegado
        if (data && data.nodes) {
            for (const freshNode of data.nodes) {
                if (!freshNode) continue;
                const id = freshNode.id.split("/").pop();
                const stockVariants = freshNode.variants.edges.map(v => ({
                    id: v.node.id.split("/").pop(),
                    title: v.node.title,
                    inventoryQuantity: v.node.inventoryQuantity,
                    availableForSale: v.node.availableForSale,
                    selectedOptions: v.node.selectedOptions
                }));
                liveStockCache.set(String(id), { variants: stockVariants, ts: Date.now() });
            }
        }

        // Devolvemos TODOS los productos aplicando el stock cacheado (recién o no)
        return products.map(p => applyCachedStock(p));

    } catch (error) {
        console.error("❌ Error actualizando stock live:", error);
        return products; // En caso de error, usamos el índice tal cual
    }
}

// Aplica el stock cacheado a un producto, conservando precio e imagen del índice.
function applyCachedStock(product) {
    const cached = liveStockCache.get(String(product.id));
    if (!cached) return product; // Sin datos frescos: devolvemos el producto tal cual

    const mergedVariants = cached.variants.map(sv => {
        const oldVariant = product.variants.find(oldV => oldV.id === sv.id);
        return {
            id: sv.id,
            title: sv.title,
            // Precio e imagen vienen del índice (pesan y cambian poco)
            price: oldVariant?.price || "Consultar",
            image: oldVariant?.image || "",
            // Datos de stock frescos desde cache
            inventoryQuantity: sv.inventoryQuantity,
            availableForSale: sv.availableForSale,
            selectedOptions: sv.selectedOptions
        };
    });

    return { ...product, variants: mergedVariants };
}

// 🚚 RASTREADOR DE PEDIDOS: Busca estado, tracking y transportista
async function getOrderStatus(orderId, userEmail) {
    const cleanId = orderId.replace("#", "").trim();
    debugLog(`🔍 Consultando Shopify para ID: ${cleanId}, Email user: ${userEmail}`);

    const query = `
    query getOrder($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          name email displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          fulfillments { trackingInfo { number url company } }
          lineItems(first: 10) { edges { node { title quantity } } }
        }
      }
    }
    `;

    try {
        const data = await fetchGraphQL(query, { query: `name:${cleanId}` });

        if (!data || !data.orders || data.orders.nodes.length === 0) {
            return { found: false, reason: "not_found" };
        }

        const order = data.orders.nodes[0];

        // 🔒 VERIFICACIÓN DE SEGURIDAD
        if (order.email.toLowerCase().trim() !== userEmail.toLowerCase().trim()) {
            return { found: false, reason: "email_mismatch" };
        }

        // Formatear lista de artículos
        let itemsText = "Varios artículos";
        if (order.lineItems && order.lineItems.edges) {
            itemsText = order.lineItems.edges.map(e => `${e.node.quantity}x ${e.node.title}`).join(", ");
        }

        // Lógica para detectar si ha salido o no
        const isUnfulfilled = order.displayFulfillmentStatus === "UNFULFILLED";
        const tracking = (order.fulfillments && order.fulfillments[0]?.trackingInfo[0]) || null;

        let carrierName = "Pendiente de envío";
        let trackingNumber = "En preparación";
        let finalTrackingUrl = null;

        if (!isUnfulfilled) {
            carrierName = tracking?.company || "Agencia de transporte";
            trackingNumber = tracking?.number || "No disponible";
            finalTrackingUrl = tracking?.url || null;

            // Correcciones de nombres y links oficiales
            if (carrierName === "0002") carrierName = "Correos Express";
            if (carrierName === "0003") {
                carrierName = "DHL";
                if (tracking?.number) {
                    finalTrackingUrl = `https://www.dhl.com/es-es/home/tracking.html?tracking-id=${tracking.number}&submit=1`;
                }
            }
        }

        return {
            found: true,
            data: {
                id: order.name,
                status: order.displayFulfillmentStatus,
                trackingNumber: trackingNumber,
                trackingUrl: finalTrackingUrl,
                carrier: carrierName,
                items: itemsText,
                price: order.totalPriceSet?.shopMoney?.amount || ""
            }
        };

    } catch (error) {
        console.error("❌ Error buscando pedido:", error);
        return { found: false, reason: "error" };
    }
}


/* ==========================================================================
   🤖 CEREBRO IA (INDEXADO Y FORMATEO)
   ========================================================================== */

let aiIndex = []; // Aquí viven los productos en memoria RAM
let faqIndex = []; // Aquí viven las FAQs en memoria RAM
const INDEX_FILE = "./ai-index.json";
const FAQ_FILE = "./faqs.json";

function buildAIText(product) {
    return `TIPO: ${product.productType}\nTITULO: ${product.title}\nDESC: ${product.description}\nTAGS: ${product.tags.join(", ")}`;
}

// Tabla de Supabase donde persistimos el índice de embeddings.
// (Requiere crear la tabla con el SQL incluido en SUPABASE_SETUP.sql)
const AI_INDEX_TABLE = "ai_index";

// 📥 Intenta cargar el índice de productos (con embeddings) desde Supabase.
// Devuelve un array; vacío si no hay nada o falla.
async function loadIndexFromSupabase() {
    try {
        // Paginamos por si hay muchos productos (Supabase limita ~1000 por query).
        let all = [];
        let from = 0;
        const page = 1000;
        while (true) {
            const { data, error } = await supabase
                .from(AI_INDEX_TABLE)
                .select("payload")
                .range(from, from + page - 1);
            if (error) { console.error("⚠️ Error leyendo índice de Supabase:", error.message); break; }
            if (!data || data.length === 0) break;
            all = all.concat(data.map(r => r.payload));
            if (data.length < page) break;
            from += page;
        }
        return all;
    } catch (e) {
        console.error("⚠️ Excepción leyendo índice de Supabase:", e.message);
        return [];
    }
}

// 💾 Guarda el índice de productos en Supabase (una fila por producto).
async function saveIndexToSupabase(index) {
    if (!index || index.length === 0) return;
    try {
        const rows = index.map(p => ({ id: String(p.id), payload: p, updated_at: new Date() }));
        // Subimos en lotes para no exceder límites de tamaño de petición.
        const batchSize = 100;
        for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);
            const { error } = await supabase.from(AI_INDEX_TABLE).upsert(batch, { onConflict: "id" });
            if (error) { console.error("⚠️ Error guardando índice en Supabase:", error.message); return; }
        }
        console.log(`💾 Índice persistido en Supabase (${rows.length} productos).`);
    } catch (e) {
        console.error("⚠️ Excepción guardando índice en Supabase:", e.message);
    }
}

// Hash del texto que vectorizamos: si no cambia, reutilizamos el embedding.
function contentHash(product) {
    return crypto.createHash("md5").update(buildAIText(product)).digest("hex");
}

// Borra de Supabase los productos que ya no existen en Shopify.
async function deleteFromSupabase(ids) {
    if (!ids || ids.length === 0) return;
    try {
        const { error } = await supabase.from(AI_INDEX_TABLE).delete().in("id", ids.map(String));
        if (error) console.error("⚠️ Error borrando productos de Supabase:", error.message);
    } catch (e) {
        console.error("⚠️ Excepción borrando de Supabase:", e.message);
    }
}

// 🔄 SINCRONIZACIÓN INCREMENTAL DEL CATÁLOGO
// Descarga la lista de Shopify y SOLO vectoriza lo nuevo o lo que ha cambiado.
// Reutiliza los embeddings existentes para lo que no ha cambiado (barato).
// Maneja también productos borrados. Pensado para ejecutarse periódicamente.
let isSyncing = false;
async function syncCatalog() {
    if (isSyncing) { debugLog("↩️ Sync ya en curso, se omite."); return; }
    isSyncing = true;
    try {
        const products = await getAllProducts();
        if (!products || products.length === 0) {
            console.warn("⚠️ Sync: Shopify devolvió 0 productos, no toco el índice.");
            return;
        }

        // Índice actual por id para reutilizar embeddings.
        const currentById = new Map(aiIndex.map(p => [String(p.id), p]));

        const newIndex = [];
        const toUpsert = [];
        let embedded = 0;

        for (const p of products) {
            const id = String(p.id);
            const existing = currentById.get(id);
            const hash = contentHash(p);

            if (existing && existing.embedding && existing._hash === hash) {
                // Sin cambios: reutilizamos el embedding existente.
                newIndex.push({ ...p, embedding: existing.embedding, _hash: hash });
            } else if (existing && existing.embedding && !existing._hash && contentHash(existing) === hash) {
                // Entrada antigua sin _hash pero con el mismo contenido: reutilizamos.
                newIndex.push({ ...p, embedding: existing.embedding, _hash: hash });
            } else {
                // Nuevo o cambiado: re-vectorizamos.
                const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: buildAIText(p) });
                const entry = { ...p, embedding: emb.data[0].embedding, _hash: hash };
                newIndex.push(entry);
                toUpsert.push(entry);
                embedded++;
            }
        }

        // Detectamos borrados: ids que estaban antes y ya no vienen de Shopify.
        const freshIds = new Set(products.map(p => String(p.id)));
        const removedIds = [...currentById.keys()].filter(id => !freshIds.has(id));

        // Aplicamos cambios en memoria
        aiIndex = newIndex;

        // Persistimos solo lo necesario
        if (toUpsert.length > 0) await saveIndexToSupabase(toUpsert);
        if (removedIds.length > 0) await deleteFromSupabase(removedIds);

        // Refrescamos la caché local
        try { fs.writeFileSync(INDEX_FILE, JSON.stringify(aiIndex)); } catch (e) { /* fs efímero */ }

        if (embedded > 0 || removedIds.length > 0) {
            console.log(`🔄 Sync: ${embedded} nuevos/cambiados vectorizados, ${removedIds.length} borrados. Total: ${aiIndex.length}.`);
        } else {
            debugLog(`🔄 Sync: sin cambios (${aiIndex.length} productos).`);
        }
    } catch (error) {
        console.error("❌ Error en syncCatalog:", error.message);
    } finally {
        isSyncing = false;
    }
}

// Carga los productos al iniciar el servidor (Caché -> O descarga nueva)
// force=true ignora las cachés (local y Supabase) y reconstruye desde Shopify.
async function loadIndexes(force = false) {
    if (force) { aiIndex = []; console.log("♻️ Reindexación forzada: ignorando cachés."); }

    // 1. Intentamos cargar de caché local primero para arrancar rápido
    if (!force && fs.existsSync(INDEX_FILE)) {
        console.log("📦 Cargando productos desde caché (arranque rápido)...");
        try {
            aiIndex = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
        } catch (e) {
            console.error("⚠️ Caché corrupta, se ignorará.");
            aiIndex = [];
        }
    }

    // 1.5 Si la caché local está vacía (típico en Render tras un reinicio),
    //     intentamos cargar el índice ya vectorizado desde Supabase. Así NO
    //     volvemos a llamar a OpenAI para re-embeddear todo el catálogo.
    if (!force && aiIndex.length === 0) {
        console.log("☁️ Caché local vacía: intentando cargar índice desde Supabase...");
        const fromDb = await loadIndexFromSupabase();
        if (fromDb.length > 0) {
            aiIndex = fromDb;
            console.log(`✅ Índice cargado desde Supabase: ${aiIndex.length} productos (sin re-vectorizar).`);
            // Reescribimos la caché local para acelerar el siguiente arranque.
            try { fs.writeFileSync(INDEX_FILE, JSON.stringify(aiIndex)); } catch (e) { /* fs efímero */ }
        }
    }

    // 2. Si SIGUE sin haber datos, descargamos de Shopify y vectorizamos.
    if (aiIndex.length === 0) {
        console.log("🤖 Indexando productos en Shopify (esto puede tardar)...");
        try {
            const products = await getAllProducts();
            
            if (products.length > 0) {
                // Limpiamos el índice anterior antes de llenar
                const tempIndex = [];
                for (const p of products) {
                    // Vectorizamos cada producto para que la IA lo entienda
                    const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: buildAIText(p) });
                    tempIndex.push({ ...p, embedding: emb.data[0].embedding });
                }
                aiIndex = tempIndex; // Actualizamos la memoria

                try {
                    fs.writeFileSync(INDEX_FILE, JSON.stringify(aiIndex));
                    console.log("💾 Índice guardado en disco.");
                } catch (e) { console.error("⚠️ No se pudo guardar caché en disco (read-only system?)"); }

                // 🔥 Persistimos también en Supabase para no re-vectorizar en cada arranque.
                await saveIndexToSupabase(aiIndex);
            } else {
                console.warn("⚠️ Advertencia: Shopify devolvió 0 productos.");
            }
        } catch (error) {
            console.error("❌ ERROR CRÍTICO INDEXANDO:", error);
            // No hacemos throw para que el servidor no se caiga
        }
    }
    console.log(`✅ Productos listos en memoria: ${aiIndex.length}`);

    // Carga de FAQs
    if (fs.existsSync(FAQ_FILE)) {
        try {
            const rawFaqs = JSON.parse(fs.readFileSync(FAQ_FILE, "utf8"));
            faqIndex = [];
            console.log("🤖 Indexando FAQs...");
            for (const f of rawFaqs) {
                const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: f.question });
                faqIndex.push({ ...f, embedding: emb.data[0].embedding });
            }
            console.log(`✅ FAQs listas: ${faqIndex.length}`);
        } catch(e) { console.error("Error cargando FAQs:", e); }
    }
}

// 🧹 REFINAMIENTO: Traduce "quiero unos pantalones" a una query técnica
async function refineQuery(userQuery, history) {
  try {
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: `Eres un experto en entender búsquedas de productos de eCommerce.
                TU OBJETIVO: Generar la cadena de búsqueda perfecta para una base de datos vectorial.

                REGLAS DE ORO:
                1. Contexto: Mira el historial. Si el usuario dice "quiero esa", busca el nombre del producto anterior.
                
                2. 🕵️‍♂️ PRECISIÓN vs VARIEDAD:
                   - Si el usuario especifica "V2", "V3", "V4": INCLÚYELO (ej: "Naluns M V2 guia tallas").
                   - Si el usuario busca un nombre GENÉRICO (ej: "Naluns"):
                     -> ¡NO inventes "original" ni "versión 1"! QUEREMOS QUE SALGAN TODAS.
                     -> Busca SOLO el nombre principal (ej: "Naluns") para que la base de datos devuelva Naluns M, W, V2, V3...
                `
            },
            ...history.slice(-4),
            { role: "user", content: userQuery }
        ],
        temperature: 0
    });
    return response.choices[0].message.content;
  } catch (error) {
    // Si OpenAI falla aquí, no tumbamos el endpoint: seguimos con la query original.
    console.error("⚠️ refineQuery falló, uso la query original:", error.message);
    return userQuery;
  }
}

// 🛡️ FORMATO DE STOCK SEGURO: Agrupa por color y oculta cantidades exactas
function formatStockForAI(variants) {
    if (!variants || variants.length === 0) return "Sin información de stock.";

    const stockByColor = {};

    variants.forEach(variant => {
        const qty = variant.inventoryQuantity;
        const isAvailable = variant.availableForSale;

        let color = "Color Único";
        let size = "Talla Única";

        // Intentamos sacar Color y Talla limpios
        if (variant.selectedOptions) {
            variant.selectedOptions.forEach(opt => {
                if (opt.name.toLowerCase() === "color") color = opt.value;
                if (opt.name.toLowerCase().includes("talla") || opt.name.toLowerCase() === "size") size = opt.value;
            });
        }

        if (!stockByColor[color]) stockByColor[color] = { sizes: [], available: false };

        if (isAvailable && qty > 0) {
            stockByColor[color].available = true;
            // FOMO: Si hay 2 o menos, añadimos etiqueta de urgencia
            const sizeLabel = qty <= 2 ? `${size} (¡últimas!)` : size;
            stockByColor[color].sizes.push(sizeLabel);
        }
    });

    // Construimos el texto resumen para la IA
    let stockInfo = "RESUMEN DE STOCK ACTUAL:\n";
    for (const [color, data] of Object.entries(stockByColor)) {
        if (data.available && data.sizes.length > 0) {
            stockInfo += `- ${color}: Tallas disponibles (${data.sizes.join(", ")})\n`;
        } else {
            stockInfo += `- ${color}: 🔴 AGOTADO\n`;
        }
    }
    return stockInfo;
}


/* ==========================================================================
   🚪 ENDPOINT PRINCIPAL (/api/ai/search)
   ========================================================================== */
/* ==========================================================================
   🚪 ENDPOINT PRINCIPAL (/api/ai/search)
   ========================================================================== */
app.post("/api/ai/search", rateLimiter, async (req, res) => {
    // 🔥🔥 AÑADIDO: 'context_handle' para saber dónde está el usuario
    const { q, history, visible_ids, session_id, context_handle } = req.body;
    if (!q || typeof q !== "string" || !q.trim()) {
        return res.status(400).json({ error: "Falta query" });
    }
    // 🛡️ Límite de longitud: evita prompt injection masivo y costes desbocados
    if (q.length > 1000) {
        return res.status(400).json({ error: "La consulta es demasiado larga." });
    }

    // 👋 ATAJO SMALL TALK: si es solo un saludo/agradecimiento, respondemos sin
    // gastar las 3 llamadas a OpenAI (refine + embedding + chat). Solo si no hay
    // producto en pantalla (en ese caso sí queremos el contexto del producto).
    if (!context_handle && isSmallTalk(q)) {
        const reply = smallTalkReply(q);
        // Guardamos la interacción en Supabase sin bloquear la respuesta
        const sid = session_id || "anonimo";
        const turn = [
            { role: "user", content: q, timestamp: new Date().toISOString() },
            { role: "assistant", content: reply, timestamp: new Date().toISOString() }
        ];
        supabase.from('chat_sessions').upsert({
            session_id: sid,
            conversation: [...(history || []), ...turn],
            category: "GENERAL",
            updated_at: new Date()
        }, { onConflict: 'session_id' }).then(({ error }) => { if (error) console.error("❌ Error Supabase (smalltalk):", error.message); });

        return res.json({ products: [], text: reply, isSizeContext: false });
    }

    try {
        // ---------------------------------------------------------
        // 1. 🔍 DETECCIÓN Y SEGURIDAD DE PEDIDOS
        // ---------------------------------------------------------
        let emailMatch = q.match(/[\w.-]+@[\w.-]+\.\w+/); // Detecta emails
        let orderMatch = q.match(/#?(\d{4,})/);            // Detecta números largos

        // Si falta algo, miramos en el historial del chat
        if ((!emailMatch || !orderMatch) && history) {
            const reversedHistory = [...history].reverse();
            const historyText = reversedHistory.map(h => h.content).join(" ");
            if (!emailMatch) emailMatch = historyText.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (!orderMatch) orderMatch = historyText.match(/#?(\d{4,})/);
        }

        if (emailMatch && emailMatch[0].includes("izas-outdoor.com")) {
            emailMatch = null;
        }

        let orderData = null;
        let securityWarning = null; // 🚦 SEMÁFORO DE SEGURIDAD

        if (orderMatch && emailMatch) {
            // CASO A: TENEMOS LOS DOS DATOS ✅ -> CONSULTAMOS
            const orderId = orderMatch[1];
            const email = emailMatch[0];
            const result = await getOrderStatus(orderId, email);
            if (result.found) {
                orderData = `[DATOS_ENCONTRADOS]
                ID: ${result.data.id}
                ESTADO_RAW: ${result.data.status}
                TRACKING: ${result.data.trackingNumber}
                LINK: ${result.data.trackingUrl || "No disponible"}
                CARRIER: ${result.data.carrier}
                ITEMS: ${result.data.items}
                PRECIO: ${result.data.price}`;
            } else if (result.reason === "email_mismatch") {
                orderData = "❌ ERROR SEGURIDAD: El email proporcionado no coincide.";
            } else {
                orderData = "❌ ERROR: No existe ningún pedido con ese número.";
            }
        } else if (orderMatch && !emailMatch) {
            securityWarning = "FALTA_EMAIL";
        } else if (!orderMatch && emailMatch) {
            securityWarning = "FALTA_PEDIDO_ID";
        }

        // ---------------------------------------------------------
        // 2. 🧠 BÚSQUEDA SEMÁNTICA (PRODUCTOS)
        // ---------------------------------------------------------
        const normalizedQuery = normalizeQuery(q); // Aplicamos normalización (Tallas XXL->2XL)
        const optimizedQuery = await refineQuery(normalizedQuery, history || []);
        
        if (aiIndex.length === 0) await loadIndexes();

        // 🔥🔥🔥 CONTEXTO WEB: Detectamos si hay un producto en pantalla 🔥🔥🔥
        let productOnScreen = null;
        if (context_handle) {
            productOnScreen = aiIndex.find(p => p.handle === context_handle);
        }

        // Filtramos productos que el usuario ya tiene en pantalla (chat anterior)
        let contextProducts = [];
        if (visible_ids && visible_ids.length > 0) {
            contextProducts = aiIndex.filter(p => visible_ids.map(String).includes(String(p.id)));
        }

        // Buscamos en el vector DB
        const embResponse = await openai.embeddings.create({ model: "text-embedding-3-large", input: optimizedQuery });
        const vector = embResponse.data[0].embedding;

        // Scoring y Lógica de Versiones
        const versionMatch = optimizedQuery.match(/\b(v\d+|ii|iii)\b/i);
        const targetVersion = versionMatch ? versionMatch[0].toLowerCase() : null;

        const searchResults = aiIndex
            .map(p => {
                let score = cosineSimilarity(vector, p.embedding);
                const titleLower = p.title.toLowerCase();
                const queryLower = optimizedQuery.toLowerCase().trim();

                // 🔥 CAMBIO 1: BOOST ACUMULATIVO
                // En lugar de ".some()" (alguna), usamos un bucle.
                // Si la búsqueda tiene 2 palabras clave, sumamos puntos por CADA una.
                const coreKeywords = queryLower.split(/\s+/).filter(w => w.length > 3);
                
                coreKeywords.forEach(kw => {
                    if (titleLower.includes(kw)) {
                        score += 0.5; // Damos 0.5 puntos por CADA coincidencia de palabra
                    }
                });

                // Penalización/Boost por versión (Esto lo dejamos igual, está bien)
                if (targetVersion) {
                    if (titleLower.includes(targetVersion)) {
                        score += 0.4;
                    } else {
                        score -= 0.3;
                    }
                }
                return { ...p, score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 20); // 🔥 CAMBIO 2: Subimos de 8 a 20 para que quepan variantes de ambos modelos

        // Buscamos FAQs similares
        const faqResults = faqIndex
            .map(f => ({ ...f, score: cosineSimilarity(vector, f.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 2);

        // Unimos los resultados
        const combinedCandidates = new Map();

        // 1. PRIORIDAD TOTAL: Producto que el usuario está viendo
        if (productOnScreen) {
            combinedCandidates.set(String(productOnScreen.id), productOnScreen);
        }

        // 2. Productos contexto chat
        contextProducts.forEach(p => combinedCandidates.set(String(p.id), p));
        
        // 3. Resultados de búsqueda
        searchResults.forEach(p => {
            if (combinedCandidates.size < 10) combinedCandidates.set(String(p.id), p);
        });
        
        let finalCandidatesList = Array.from(combinedCandidates.values());

        // 🔥🔥🔥 LIVE STOCK CHECK: Actualizamos datos con Shopify en TIEMPO REAL 🔥🔥🔥
        finalCandidatesList = await getLiveStockForProducts(finalCandidatesList);

        // Generamos el texto que leerá la IA
        const productsContext = finalCandidatesList.map(p => {
            const isViewing = productOnScreen && String(p.id) === String(productOnScreen.id) ? " (🔥 VIENDO AHORA)" : "";
            const colorOption = p.options ? p.options.find(o => o.name.match(/color|cor/i)) : null;
            const officialColors = colorOption ? colorOption.values.join(", ") : "Único";
            const cleanDescription = cleanText(p.body_html || p.description);
            const stockText = formatStockForAI(p.variants); // Generado con datos frescos
            let metaInfo = "";
             if (p.metafields) {
                 metaInfo = Object.entries(p.metafields)
                     .map(([key, val]) => {
                         // Si el valor es una lista o JSON, lo convertimos a texto
                         const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
                         // Limpiamos HTML si lo hubiera
                         return `${key}: ${cleanText(valStr)}`;
                     })
                     .join(" | ");
             }

            // ETIQUETA VISUAL PARA LA IA
            let tag = "";
            if (productOnScreen && String(p.id) === String(productOnScreen.id)) tag = " (🔥 USUARIO VIENDO AHORA)";
            else if (visible_ids && visible_ids.map(String).includes(String(p.id))) tag = " (EN PANTALLA)";

            return `PRODUCTO${isViewing}:
            - ID: ${p.id}
            - Título: ${p.title}
            - Tags:${p.tags.join(",")}
            - Desc:${cleanText(p.body_html)}
            - InfoExtra:${metaInfo}
            - Precio: ${p.price} €
            - Colores: ${officialColors}
            - Stock: ${stockText}`;
        }).join("\n\n");

        // ---------------------------------------------------------
        // 3. 🗣️ GENERACIÓN DE RESPUESTA (OPENAI)
        // ---------------------------------------------------------
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            response_format: { type: "json_object" },
            temperature: 0.1,
            messages: [
                {
                    role: "system",
                    content: `Eres el asistente virtual oficial de Izas Outdoor. Tu tono es cercano, profesional y aventurero.

                    🌍 CONTROL DE IDIOMA (PRIORIDAD MÁXIMA):
                    1. DETECTA AUTOMÁTICAMENTE el idioma en el que escribe el usuario.
                    2. RESPONDE SIEMPRE en ese mismo idioma.
                    3. Si la información de los productos (título, descripción, stock) que te doy abajo está en español, TRADÚCELA al idioma del usuario en tu respuesta final.

                    🔥 CONTEXTO WEB (IMPORTANTE):
                    - Si ves un producto marcado con "(🔥 USUARIO VIENDO AHORA)", significa que el cliente está en esa página web.
                    - Si pregunta "qué precio tiene", "hay talla", "cómo talla" o "tabla de medidas" SIN DECIR EL NOMBRE, SE REFIERE A ESE PRODUCTO.
                    - Priorízalo en tu respuesta.
                    - ⚠️ OBLIGATORIO: Si el cliente está viendo un producto, DEBES INCLUIRLO SIEMPRE en el array "products" de tu respuesta JSON, incluso si solo estás dando información de tallas o envíos.
                    - El panel lateral depende de que tú envíes ese producto en el JSON. No falles.

                    🏷️ CATEGORÍAS DISPONIBLES (Para el campo 'category'):
                    - TALLAJE: Tallas, medidas, guías.
                    - PEDIDOS: Envíos, plazos, costes.
                    - DEVOLUCION/CAMBIO: Devoluciones, cambios.
                    - PRODUCTO: Info de producto, stock, características.
                    - TIENDA: Tiendas físicas.
                    - HUMANO: Piden hablar con humano.
                    - GENERAL: Saludo, otros.

                    ⛔ REGLAS DE SEGURIDAD (IMPORTANTE):
                    1. COMPETENCIA Y CANALES: Decathlon, Amazon... son partners. No mientas. Recomienda comprar en web oficial.
                    2. CONOCIMIENTO: Usa "PRODUCTOS DISPONIBLES". Si no sabes, dilo.
                    3. REDES SOCIALES: instagram @izasofficial, tiktok @izas_official, facebook @IzasOutdoor, pinterest @IzasOutdoor. No tenemos inguna otra red social. Si te piden el enlace de cualquiera de las tres, dáselo correctamente formado, incluyendo el https de forma que se pueda acceder a él.

                    📍 REGLA ESPECIAL TIENDAS:
                    - Si preguntan por tiendas físicas, ubicación o disponibilidad de stock en tienda física:
                    - ⚠️ ACLARACIÓN VITAL: Debes dejar muy claro que actualmente NO es posible consultar el stock de las tiendas físicas a través de la web. Para saber si una prenda está en una tienda, el cliente debe llamar o visitar la tienda directamente.
                    - Para que busquen su tienda más cercana, dales este enlace EXACTAMENTE así, en texto plano (prohibido usar formato Markdown [texto](url) o etiquetas HTML <a>): https://www.izas-outdoor.com/pages/localizador-de-tiendas

                    3. GESTIÓN DE STOCK Y CONTEXTO VISUAL (¡MUY IMPORTANTE!):
                        - CRUCIAL: LEE EL CAMPO 'Stock:' DE CADA PRODUCTO.
                        - Si dice "Tallas disponibles (S, M, L)", ENTONCES SÍ HAY STOCK. No inventes que está agotado.
                        - Si un color tiene tallas y otro no, ESPECIFÍCALO CLARAMENTE.
                        - Ejemplo correcto: "El modelo Konka en Azul tiene S y M. En Rojo está agotado."
                    
                    4. 👨‍👩‍👧‍👦 GESTIÓN DE FAMILIAS (EL "MODO CARRUSEL"):
                        - ACTIVACIÓN: Si el usuario busca un nombre genérico (ej: "Anger", "Naluns") y ves varios resultados distintos.
                        - ACCIÓN:
                          1. JSON "reply": "He encontrado varias opciones para [Nombre]. Por favor, selecciona abajo el modelo exacto."
                          2. ⚠️ JSON "products": [ID1, ID2, ID3...] <-- ¡OBLIGATORIO LLENARLO CON TODO LO ENCONTRADO!
                        - PROHIBIDO: No des enlaces de tallas ni precios específicos en el texto si estás en este modo. Obliga al usuario a clicar en la tarjeta.

                    5. 🚨 DERIVACIÓN A HUMANO (PRIORIDAD MÁXIMA):
                        - Si piden "agente", "humano", "persona": NO INTENTES AYUDAR.
                        - RESPUESTA OBLIGATORIA: "¡Claro! Escríbenos a info@izas-outdoor.com o llama al 976502040 dentro del horario laboral."
                        - ETIQUETA: "DERIVACION_HUMANA"

                    6. 🕵️‍♂️ BÚSQUEDA CRUZADA DE TALLAS (¡CRÍTICO!):
                        - Si el usuario pregunta "¿Hay talla XXL de la Konka?":
                        - 🛑 NO mires solo el primer producto y digas "No".
                        - ✅ REVISA TODOS los productos listados abajo.
                        - Si el producto 1 no tiene, pero el producto 2 sí, responde: "Sí, la tengo disponible en talla XXL en color [Color del Producto 2]".

                    --- DATOS ---
                    ALERTA SEGURIDAD: ${securityWarning || "Ninguna"}
                    DATOS PEDIDO LIVE: ${orderData || "N/A"}
                    DATOS DE MARCA: ${BRAND_INFO}
                    FAQs: ${faqResults.map(f => `P:${f.question} R:${f.answer}`).join("\n")}
                    PRODUCTOS DISPONIBLES: ${productsContext}

                    Responde JSON: { "reply": "...", "products": [...], "category": "ETIQUETA" }
                    `
                },
                ...history.slice(-2).map(m => ({ role: m.role, content: m.content })),
                // 🔥 AVISAMOS AL PROMPT DEL CONTEXTO
                { role: "user", content: `Usuario busca: "${q}" (Interpretado como: "${normalizedQuery}") ${productOnScreen ? "[Contexto: Usuario viendo " + productOnScreen.title + "]" : ""}` }
            ]
        });

        // ---------------------------------------------------------
        // 4. 🖼️ PROCESADO FINAL BLINDADO (SANITIZACIÓN)
        // ---------------------------------------------------------
        const rawContent = completion.choices[0].message.content;
        debugLog("RAW OPENAI RESPONSE:", rawContent);

        let aiContent;
        try {
            // Usamos el extractor robusto por si GPT mete texto introductorio
            aiContent = extractJSON(rawContent);
        } catch (err) {
            console.error("❌ ERROR PARSEANDO JSON:", err);
            aiContent = { 
                reply: "Lo siento, me he liado procesando tu solicitud. ¿Podrías repetirmela de otra forma?", 
                products: [], 
                category: "ERROR_JSON" 
            };
        }

        const seenIds = new Set();
        const finalProducts = (aiContent.products || []).map(aiProd => {
            const targetId = typeof aiProd === 'object' ? aiProd.id : aiProd;
            
            // Buscamos el producto original en memoria
            const original = finalCandidatesList.find(p => String(p.id) === String(targetId));
            
            if (!original || seenIds.has(original.id)) return null;
            seenIds.add(original.id);

            // SANITIZACIÓN: Aseguramos que no haya campos NULL que rompan el frontend
            const safeProduct = {
                ...original,
                title: original.title || "Producto Izas",
                price: original.price || "0.00",
                image: original.image || "https://cdn.shopify.com/s/files/1/0000/0000/t/1/assets/no-image.jpg", // Placeholder
                variants: original.variants || [],
                options: original.options || []
            };

            // Lógica de variante específica (si la IA recomienda un color concreto)
            let displayImage = safeProduct.image;
            let displayUrlParams = "";
            
            if (typeof aiProd === 'object' && aiProd.variant_id && safeProduct.variants.length > 0) {
                const v = safeProduct.variants.find(v => String(v.id) === String(aiProd.variant_id));
                if (v) { 
                    if (v.image) displayImage = v.image; 
                    displayUrlParams = `?variant=${v.id}`; 
                }
            }
            
            return { ...safeProduct, displayImage, displayUrlParams };
        }).filter(Boolean); // Eliminamos los nulos

        // ---------------------------------------------------------
        // 🔥 4.5 FIX URLS: QUITAR PUNTOS FINALES DE LOS ENLACES
        // ---------------------------------------------------------
        if (aiContent && aiContent.reply) {
            // Esta expresión regular busca URLs que terminen en punto, coma o dos puntos
            // y elimina ese signo de puntuación para que el click funcione bien.
            aiContent.reply = aiContent.reply.replace(/(https?:\/\/[^\s]+)[.,:;](?=\s|$)/g, '$1');
        }
        // ---------------------------------------------------------
        // 5. 💾 GUARDADO EN SUPABASE (HISTORIAL)
        // ---------------------------------------------------------
        const currentSessionId = session_id || "anonimo";
        
        // Enriquecemos el log del asistente con los nombres de los productos recomendados
        let enrichedReply = aiContent.reply;
        if (finalProducts.length > 0) {
            const productNames = finalProducts.map(p => p.title).join(", ");
            enrichedReply += `\n[CONTEXTO SISTEMA: Productos mostrados: ${productNames}]`;
        }

        // Construimos el historial para guardar
        const newInteraction = [
          { 
            role: "user", 
            content: q, 
            timestamp: new Date().toISOString() // Ej: "2024-02-10T15:30:00.000Z" (Formato universal)
          },
          { 
            role: "assistant", 
            content: enrichedReply, 
            timestamp: new Date().toISOString() 
          }
        ];
        const fullHistoryToSave = [...(history || []), ...newInteraction];

        supabase.from('chat_sessions').upsert({
            session_id: currentSessionId,
            conversation: fullHistoryToSave,
            category: aiContent.category || "GENERAL",
            updated_at: new Date()
        }, { onConflict: 'session_id' }).then(({ error }) => { if (error) console.error("❌ Error Supabase:", error); });

        const isSizeContext = /talla|medida|guia|dimension|size/i.test(q);
        
        // Enviamos la respuesta final limpia al Frontend
        res.json({ 
            products: finalProducts, 
            text: aiContent.reply, 
            isSizeContext: isSizeContext 
        });

    } catch (error) {
        console.error("❌ ERROR:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   👋 ENDPOINT DE INICIO (/api/chat/init)
   ==========================================================================
   El frontend llama a este endpoint al abrir el chat por primera vez.
   Devuelve el saludo inicial y registra la apertura de sesión en Supabase. */
const WELCOME_MESSAGE = "¡Hola! Soy el asistente experto de Izas. 🏔️ ¿En qué puedo ayudarte? Puedo buscarte productos, resolver dudas de tallas, envíos o devoluciones, o consultar el estado de tu pedido.";

app.post("/api/chat/init", rateLimiter, async (req, res) => {
    res.json({ text: WELCOME_MESSAGE });
});

/* ==========================================================================
   📝 ENDPOINT PARA GUARDAR LOGS MANUALES (Feedback, Botones, etc.)
   ========================================================================== */
app.post("/api/chat/log", rateLimiter, async (req, res) => {
    const { session_id, role, content } = req.body;

    if (!session_id || !role || !content) return res.status(400).json({ error: "Faltan datos" });

    try {
        // 1. Recuperamos la conversación actual
        const { data: session } = await supabase
            .from('chat_sessions')
            .select('conversation')
            .eq('session_id', session_id)
            .single();

        // Si no existe sesión, creamos array nuevo; si existe, usamos el historial
        let history = session && session.conversation ? session.conversation : [];

        // 2. Añadimos el nuevo mensaje
        history.push({
            role: role, // 'assistant' (botones) o 'user' (click en sí/no)
            content: content,
            timestamp: new Date()
        });

        // 3. Guardamos la actualización
        const { error } = await supabase
            .from('chat_sessions')
            .upsert({
                session_id: session_id,
                conversation: history,
                updated_at: new Date()
            });

        if (error) throw error;

        debugLog(`💾 Log manual guardado para sesión ${session_id}: ${content}`);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ Error guardando log manual:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   ❤️ HEALTHCHECK (/health)
   ==========================================================================
   Útil para que Render (u otro monitor) sepa si el servicio está vivo y si
   el índice de productos ya se ha cargado en memoria. */
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        productsIndexed: aiIndex.length,
        faqsIndexed: faqIndex.length,
        uptimeSeconds: Math.round(process.uptime())
    });
});

/* ==========================================================================
   ♻️ REINDEXAR CATÁLOGO (/api/admin/reindex)
   ==========================================================================
   Reconstruye el índice desde Shopify (re-vectoriza) y lo persiste en Supabase.
   Úsalo cuando cambies productos. Protegido con ADMIN_TOKEN. */
app.post("/api/admin/reindex", async (req, res) => {
    const token = req.headers["x-admin-token"];
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: "No autorizado" });
    }
    // Lanzamos en segundo plano para no dejar la petición colgada mucho tiempo.
    res.json({ status: "reindexando", message: "La reindexación se está ejecutando en segundo plano." });
    loadIndexes(true)
        .then(() => console.log("✅ Reindexación manual completada."))
        .catch(err => console.error("❌ Error en reindexación manual:", err));
});

/* ==========================================================================
   🚀 INICIO DEL SERVIDOR
   ========================================================================== */
// Cada cuánto sincronizamos el catálogo automáticamente (por defecto: 6 horas).
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 6 * 60 * 60 * 1000;

app.listen(PORT, async () => {
    console.log(`🚀 Server en http://localhost:${PORT}`);

    // 1. Carga inicial del índice (caché local -> Supabase -> Shopify) sin bloquear el arranque.
    loadIndexes()
        .then(() => {
            // 2. Tras cargar, hacemos una sync incremental a los 2 min para captar
            //    productos nuevos/cambiados desde la última vez (barato: solo lo que cambió).
            setTimeout(() => { syncCatalog().catch(e => console.error("Sync inicial:", e.message)); }, 2 * 60 * 1000);
        })
        .catch(err => console.error("⚠️ Error en carga inicial:", err));

    // 3. Sync incremental periódica automática (sin intervención manual).
    setInterval(() => { syncCatalog().catch(e => console.error("Sync periódica:", e.message)); }, SYNC_INTERVAL_MS);
    console.log(`🔄 Sincronización automática de catálogo cada ${Math.round(SYNC_INTERVAL_MS / 60000)} min.`);
});










