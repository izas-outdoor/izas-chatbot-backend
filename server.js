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
   ========================================================================== */

import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from "fs";
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

PROGRAMA DE FIDELIZACIÓN (IZAS MEMBERS):
Tenemos un programa de fidelización llamado Izas Members: puntos por compra, niveles (Bronce/Plata/Oro) con ventajas como envíos gratis y descuentos. Menciónalo solo de forma breve y cuando sea relevante (p. ej. si preguntan por descuentos, ahorrar, o cómo fidelizar), y no lo repitas si ya lo mencionaste antes en la conversación. Para el detalle de cómo funciona (alta, puntos, canje, niveles, etc.), usa la información de las FAQs.
`;

/* --- ⚙️ CONFIGURACIÓN DEL SERVIDOR --- */
const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Marca los mensajes "assistant" que en realidad escribió un agente humano
// desde el visualizador interno (ver el endpoint /api/chat/agent-reply más
// abajo). Debe coincidir exactamente con el mismo marcador en el widget.
const AGENT_MARKER = '[AGENTE_HUMANO] ';
// Marca el mensaje que cierra la derivación: a partir de este punto el bot
// vuelve a contestar. Debe ser distinto de AGENT_MARKER para poder
// diferenciar "sigue derivado" de "ya se devolvió al bot".
const AGENT_CLOSE_MARKER = '[AGENTE_CIERRA] ';

// 📧 Aviso por email cuando una conversación pasa a DERIVACION_HUMANA, para
// que el equipo se entere aunque no tenga el visualizador abierto en ese
// momento (usa Resend, con vuestro dominio ya verificado).
const RESEND_FROM = 'web@izas-outdoor.com';
const AGENT_NOTIFY_EMAILS = ['it@izas-outdoor.com', 'info@izas-outdoor.com', 'mario@izas-outdoor.com'];
const VISUALIZADOR_URL = 'https://izas-visualizador-chats-chatbot.onrender.com/';

function escapeHtmlServer(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function notifyAgentEmail(sessionId, lastMessage) {
    if (!process.env.RESEND_API_KEY) {
        console.warn("⚠️ RESEND_API_KEY no configurada: no se envía el aviso de derivación.");
        return;
    }
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: RESEND_FROM,
                to: AGENT_NOTIFY_EMAILS,
                subject: '🔴 Nueva derivación a agente humano — Chat Izas',
                html: `
                    <p>Un cliente ha pedido hablar con un agente en el chatbot de la web.</p>
                    <p><b>Último mensaje del cliente:</b><br>${escapeHtmlServer(lastMessage)}</p>
                    <p><a href="${VISUALIZADOR_URL}?session=${encodeURIComponent(sessionId)}">Abrir esta conversación en el visualizador</a></p>
                    <p style="color:#888;font-size:12px;">ID de sesión: ${escapeHtmlServer(sessionId)}</p>
                `
            })
        });
        if (!res.ok) {
            console.error("❌ Error enviando email de derivación:", res.status, await res.text());
        } else {
            console.log(`📧 Aviso de derivación enviado para sesión ${sessionId}`);
        }
    } catch (err) {
        console.error("❌ Excepción enviando email de derivación:", err);
    }
}

app.use(cors({ origin: "*" })); // Permite conexiones desde cualquier lugar
app.use(express.json()); // Permite recibir datos JSON

// Credenciales Shopify
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Credenciales OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


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
    if (!text) return "Sin información";
    return text
        .replace(/<[^>]*>?/gm, " ") // Quita etiquetas <div>, <p>...
        .replace(/\s+/g, " ")       // Quita espacios dobles
        .trim()
        .substring(0, 600);         // Corta para no gastar muchos tokens
}

// Cálculo matemático para ver similitud entre vectores (Búsqueda Semántica)
function cosineSimilarity(a, b) {
    return a.reduce((acc, val, i) => acc + val * b[i], 0);
}

// Parsea JSON de forma segura
function safeParse(value) {
    try { return JSON.parse(value); } catch { return value; }
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
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`;
    
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "X-Shopify-Access-Token": ADMIN_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ query, variables }),
                timeout: 10000 // 10 segundos máximo por petición
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
                  image { url }
                }
              }
            }
            metafields(first: 20) { edges { node { namespace key value } } }
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
// 🔥 FIX CRÍTICO: Mantiene precios e imágenes si el check rápido no los trae
async function getLiveStockForProducts(products) {
    if (!products || products.length === 0) return products;

    console.log("⚡ Actualizando stock en tiempo real para", products.length, "productos...");

    // Preparamos los IDs para Shopify
    const productIds = products.map(p => `gid://shopify/Product/${p.id}`);

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
        
        if (!data || !data.nodes) return products;

        // Actualizamos los productos en memoria con los datos frescos
        return products.map(p => {
            // Buscamos el nodo fresco correspondiente
            const freshNode = data.nodes.find(n => n && n.id.endsWith(`/${p.id}`));
            
            if (!freshNode) return p; // Si falla, devolvemos el viejo

            // Mapeamos las nuevas variantes preservando datos antiguos importantes (Precio/Img)
            const freshVariants = freshNode.variants.edges.map(v => {
                const variantId = v.node.id.split("/").pop();
                // Buscamos la variante antigua para recuperar precio e imagen si faltan
                const oldVariant = p.variants.find(oldV => oldV.id === variantId);

                return {
                    id: variantId,
                    title: v.node.title,
                    // Mantenemos precio e imagen del índice (son pesados y cambian poco)
                    price: oldVariant?.price || "Consultar",
                    image: oldVariant?.image || "",
                    // DATOS CLAVE ACTUALIZADOS:
                    inventoryQuantity: v.node.inventoryQuantity,
                    availableForSale: v.node.availableForSale,
                    selectedOptions: v.node.selectedOptions
                };
            });

            return { ...p, variants: freshVariants };
        });

    } catch (error) {
        console.error("❌ Error actualizando stock live:", error);
        return products; // En caso de error, usamos el caché
    }
}

// 🚚 RASTREADOR DE PEDIDOS: Busca estado, tracking y transportista
async function getOrderStatus(orderId, userEmail) {
    const cleanId = orderId.replace("#", "").trim();
    console.log(`🔍 Consultando Shopify para ID: ${cleanId}, Email user: ${userEmail}`);

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
// 🔥 Súbelo cada vez que cambie la FORMA de los datos que guardamos en el
// índice (ej: añadir un campo nuevo tipo "imagen por variante"). Así, aunque
// quede en disco una caché vieja, se descarta y se reindexa desde Shopify en
// vez de servir datos con el campo nuevo siempre vacío.
const INDEX_SCHEMA_VERSION = 2;

function buildAIText(product) {
    return `TIPO: ${product.productType}\nTITULO: ${product.title}\nDESC: ${product.description}\nTAGS: ${product.tags.join(", ")}`;
}

// Carga los productos al iniciar el servidor (Caché -> O descarga nueva)
async function loadIndexes() {
    // 1. Intentamos cargar de caché primero para arrancar rápido
    if (fs.existsSync(INDEX_FILE)) {
        console.log("📦 Cargando productos desde caché (arranque rápido)...");
        try {
            const cached = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
            if (cached && cached.schemaVersion === INDEX_SCHEMA_VERSION && Array.isArray(cached.products)) {
                aiIndex = cached.products;
            } else {
                console.log("♻️ Caché con formato antiguo (falta imagen por variante), se ignora y se reindexa.");
                aiIndex = [];
            }
        } catch (e) {
            console.error("⚠️ Caché corrupta, se ignorará.");
            aiIndex = [];
        }
    }

    // 2. Si no hay datos (o queremos refrescar), descargamos de Shopify
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
                    fs.writeFileSync(INDEX_FILE, JSON.stringify({ schemaVersion: INDEX_SCHEMA_VERSION, products: aiIndex }));
                    console.log("💾 Índice guardado en disco.");
                } catch (e) { console.error("⚠️ No se pudo guardar caché en disco (read-only system?)"); }
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
app.post("/api/ai/search", async (req, res) => {
    // 🔥🔥 AÑADIDO: 'context_handle' para saber dónde está el usuario
    const { q, history, visible_ids, session_id, context_handle, member_context, customer_email, login_url } = req.body;
    if (!q) return res.status(400).json({ error: "Falta query" });

    // 🧑‍💼 CONVERSACIÓN DERIVADA A UN AGENTE: si ya hay una respuesta de agente
    // humano guardada en esta sesión, el bot deja de contestar (para no pisar
    // al agente). Solo guardamos el mensaje del cliente para que se vea en el
    // visualizador; no llamamos a OpenAI ni gastamos esa consulta.
    let previousCategory = null;
    if (session_id) {
        const { data: existingSession } = await supabase
            .from('chat_sessions')
            .select('conversation, category')
            .eq('session_id', session_id)
            .single();

        previousCategory = existingSession?.category || null;
        const storedConversation = existingSession?.conversation || [];

        // Miramos el ÚLTIMO mensaje marcado (de agente o de cierre), no si
        // "alguna vez" hubo un agente: así, si el agente ya devolvió la
        // conversación al bot, el bot vuelve a contestar con normalidad.
        let hasAgentTakenOver = false;
        for (let i = storedConversation.length - 1; i >= 0; i--) {
            const c = storedConversation[i]?.content;
            if (typeof c !== 'string') continue;
            if (c.startsWith(AGENT_CLOSE_MARKER)) { hasAgentTakenOver = false; break; }
            if (c.startsWith(AGENT_MARKER)) { hasAgentTakenOver = true; break; }
        }

        if (hasAgentTakenOver) {
            const updatedConversation = [
                ...storedConversation,
                { role: 'user', content: q, timestamp: new Date().toISOString() }
            ];

            const { error: handoffError } = await supabase
                .from('chat_sessions')
                .upsert({
                    session_id,
                    conversation: updatedConversation,
                    updated_at: new Date()
                });

            if (handoffError) console.error("❌ Error guardando mensaje en conversación derivada:", handoffError);

            return res.json({ handedOff: true, text: null, products: [] });
        }
    }

    // 🎖️ IZAS MEMBERS: datos del socio si el cliente tiene sesión iniciada en Shopify.
    // Vienen ya resueltos por el frontend desde /apps/izas-members/perfil (App Proxy firmado),
    // así que aquí solo los formateamos para el prompt, sin volver a consultar nada.
    const TIER_BENEFITS = {
        BRONCE: "Envío gratis desde 59,99€. Regalo de cumpleaños: 100 puntos.",
        PLATA: "Envío gratis desde 49,99€. +10% de puntos en compras de 200€ o más. Acceso anticipado a colecciones. Regalo de cumpleaños: 150 puntos.",
        ORO: "Envío siempre gratis. +20% de puntos en compras de 200€ o más. Acceso anticipado a colecciones. Regalo de cumpleaños: 200 puntos + cupón 10% (7 días)."
    };
    const loginLink = login_url || "https://www.izas-outdoor.com/account/login";

    // 🔒 El enlace de login SOLO se incluye en el prompt cuando realmente no hay sesión/socio.
    // Así el modelo no tiene "a mano" el enlace para ofrecerlo cuando ya tiene datos reales.
    let memberInfo = `N/A (el cliente no tiene sesión iniciada o no es socio Izas Members). Enlace de inicio de sesión a ofrecer: ${loginLink}`;
    if (member_context && (member_context.nivel || member_context.puntos != null)) {
        const nivelKey = (member_context.nivel || "BRONCE").toUpperCase();
        memberInfo = `Nivel: ${nivelKey} | Puntos disponibles: ${member_context.puntos ?? "N/A"} | Equivalente en descuento: ${member_context.saldoDisponible ?? "N/A"}€ | Ventajas de su nivel: ${TIER_BENEFITS[nivelKey] || "N/A"}`;
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

        // 🔐 Si el cliente tiene sesión iniciada en Shopify, usamos SIEMPRE su email verificado
        // (más seguro que confiar en uno que escriba el usuario, y evita tener que pedírselo).
        if (customer_email) {
            emailMatch = [customer_email];
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

                // Boost por coincidencia de palabras clave
                const coreKeywords = queryLower.split(" ").filter(w => w.length > 3);
                const matchesCore = coreKeywords.some(kw => titleLower.includes(kw));
                if (matchesCore) score += 0.3;

                // Penalización/Boost por versión (V2, V3...)
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
            .slice(0, 8); // Top 8 candidatos

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
            const colorOption = p.options ? p.options.find(o => o.name.match(/color|cor/i)) : null;
            const officialColors = colorOption ? colorOption.values.join(", ") : "Único";
            const cleanDescription = cleanText(p.body_html || p.description);
            const stockText = formatStockForAI(p.variants); // Generado con datos frescos

            // 🖼️ MAPA COLOR -> ID DE VARIANTE (para que la IA pueda pedir la imagen del color correcto)
            const colorVariantIds = {};
            (p.variants || []).forEach(v => {
                const colorOpt = v.selectedOptions?.find(o => o.name.toLowerCase() === "color");
                const color = colorOpt ? colorOpt.value : "Único";
                if (!colorVariantIds[color]) colorVariantIds[color] = v.id;
            });
            const variantIdsText = Object.entries(colorVariantIds).map(([c, vid]) => `${c}=${vid}`).join(", ");

            // ETIQUETA VISUAL PARA LA IA
            let tag = "";
            if (productOnScreen && String(p.id) === String(productOnScreen.id)) tag = " (🔥 USUARIO VIENDO AHORA)";
            else if (visible_ids && visible_ids.map(String).includes(String(p.id))) tag = " (EN PANTALLA)";

            return `PRODUCTO${tag}:
            - ID: ${p.id}
            - Título: ${p.title}
            - Precio: ${p.price} €
            - Colores: ${officialColors}
            - IDs de variante por color: ${variantIdsText}
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

                    ⛔ REGLAS DE SEGURIDAD (IMPORTANTE):
                    1. COMPETENCIA Y CANALES: Decathlon, Amazon... son partners. No mientas. Recomienda comprar en web oficial.
                    2. CONOCIMIENTO: Usa "PRODUCTOS DISPONIBLES". Si no sabes, dilo.

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

                    4bis. 🎨 IMAGEN DEL COLOR CORRECTO (¡MUY IMPORTANTE, EVITA UN BUG CONOCIDO!):
                        - Cada producto de abajo trae "IDs de variante por color" (ej: "WHITE=41234, BLACK=41235").
                        - Si el usuario ha pedido/filtrado por un color concreto (ej: "blancas", "en negro") o solo tiene sentido recomendar un color concreto según la conversación, NO metas el ID del producto como texto/número suelto en "products".
                        - En su lugar, mete un OBJETO: {"id": "<ID del producto>", "variant_id": "<ID de variante correspondiente a ESE color, sacado de 'IDs de variante por color'>"}.
                        - Esto es lo que hace que la tarjeta muestre la foto del color correcto (si no mandas variant_id, se muestra la foto por defecto del producto y el cliente ve un color que no pidió).
                        - Si NO hay un color concreto en juego (ej. modo carrusel de familias, o el producto es de color único), puedes seguir mandando solo el ID como antes (string o número).

                    5. 🚨 DERIVACIÓN A HUMANO (PRIORIDAD MÁXIMA):
                        - Si piden "agente", "humano", "persona": NO INTENTES AYUDAR.
                        - RESPUESTA OBLIGATORIA: "¡Claro! Voy a derivarte con un agente de nuestro equipo, que te responderá aquí mismo en cuanto pueda (horario: L-J 08:00-17:00, V 07:00-15:00). Si es fuera de ese horario, tu mensaje se queda guardado y te contestamos en cuanto abramos. Mientras tanto, cuéntame lo que necesitas y se lo dejo preparado."
                        - ETIQUETA: "DERIVACION_HUMANA"

                    6. 🕵️‍♂️ BÚSQUEDA CRUZADA DE TALLAS (¡CRÍTICO!):
                        - Si el usuario pregunta "¿Hay talla XXL de la Konka?":
                        - 🛑 NO mires solo el primer producto y digas "No".
                        - ✅ REVISA TODOS los productos listados abajo.
                        - Si el producto 1 no tiene, pero el producto 2 sí, responde: "Sí, la tengo disponible en talla XXL en color [Color del Producto 2]".

                    7. 🎖️ PUNTOS, NIVEL Y VENTAJAS DE IZAS MEMBERS (CLIENTE ACTUAL):
                        - Si el usuario pregunta por SUS puntos, nivel, saldo o "qué ventajas/beneficios tengo", usa EXCLUSIVAMENTE el bloque "DATOS SOCIO IZAS MEMBERS" de abajo (incluye ya las ventajas de su nivel concreto). No inventes ni calcules cifras, y no menciones niveles que no sean el suyo.
                        - Si ese bloque empieza por "N/A": el cliente no tiene sesión iniciada o no es socio. Explica brevemente que necesita iniciar sesión, e incluye el enlace que viene ahí mismo en formato de link: [Iniciar sesión](enlace). No reveles el motivo técnico del N/A.
                        - Si el bloque SÍ tiene Nivel/Puntos reales, NUNCA sugieras iniciar sesión ni canjees dudas sobre si la sesión está iniciada: ya lo está, responde directamente con sus datos.
                        - Para dudas generales sobre cómo funciona el programa (cómo ganar puntos, canjear, requisitos de cada nivel, etc.) usa las FAQs, no este bloque.

                    8. 📦 CONSULTA DE PEDIDOS:
                        - SÍ PUEDES consultar pedidos concretos: nunca digas que "no tienes acceso" a los pedidos.
                        - Si el usuario pregunta por sus pedidos en general (sin dar número) y "DATOS PEDIDO LIVE" es "N/A", pídele el número de pedido para buscarlo.
                        - Si "ALERTA SEGURIDAD" es "FALTA_EMAIL", pide el email de la compra. Si es "FALTA_PEDIDO_ID", pide el número de pedido. Si no hay alerta y falta el número, simplemente pídelo.
                        - Solo si tras pedir el número de pedido el cliente no puede dártelo o el sistema no lo encuentra, deriva a info@izas-outdoor.com.

                    9. 🏷️ ETIQUETA DE LA CONVERSACIÓN (campo "category"):
                        - OBLIGATORIO: elige EXACTAMENTE UNA de esta lista cerrada. Nunca inventes una etiqueta nueva ni la escribas de otra forma (ni tildes distintas, ni sinónimos, ni en otro idioma): así evitamos que la misma duda quede repartida en estadísticas bajo nombres distintos.
                        - "PRODUCTO": dudas sobre productos concretos (características, tallas, colores, stock, comparar modelos, recomendaciones).
                        - "PEDIDO": estado o seguimiento de un pedido ya realizado.
                        - "ENVIO": plazos, costes, zonas o condiciones de envío (sin ser sobre un pedido concreto).
                        - "DEVOLUCION": devoluciones, cambios o cancelaciones.
                        - "MEMBERS": cualquier cosa sobre Izas Members (puntos, nivel, ventajas, cómo funciona, alta al programa).
                        - "DERIVACION_HUMANA": ya definida en la regla 5, tiene prioridad sobre cualquier otra etiqueta.
                        - "GENERAL": todo lo demás (saludos, marca, dudas que no encajan arriba).

                    --- DATOS ---
                    ALERTA SEGURIDAD: ${securityWarning || "Ninguna"}
                    DATOS PEDIDO LIVE: ${orderData || "N/A"}
                    DATOS SOCIO IZAS MEMBERS: ${memberInfo}
                    DATOS DE MARCA: ${BRAND_INFO}
                    FAQs: ${faqResults.map(f => `P:${f.question} R:${f.answer}`).join("\n")}
                    PRODUCTOS DISPONIBLES: ${productsContext}

                    Responde JSON: { "reply": "...", "products": [...], "category": "PRODUCTO|PEDIDO|ENVIO|DEVOLUCION|MEMBERS|DERIVACION_HUMANA|GENERAL" }
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
        console.log("RAW OPENAI RESPONSE:", rawContent);

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
        const newCategory = aiContent.category || "GENERAL";

        supabase.from('chat_sessions').upsert({
            session_id: currentSessionId,
            conversation: fullHistoryToSave,
            category: newCategory,
            updated_at: new Date()
        }, { onConflict: 'session_id' }).then(({ error }) => { if (error) console.error("❌ Error Supabase:", error); });

        // Avisamos solo en el momento en que la conversación PASA a derivada
        // (no en cada mensaje mientras lo siga estando).
        if (newCategory === 'DERIVACION_HUMANA' && previousCategory !== 'DERIVACION_HUMANA') {
            notifyAgentEmail(currentSessionId, q);
        }

        const isSizeContext = /talla|medida|guia|dimension|size/i.test(q);
        
        // Enviamos la respuesta final limpia al Frontend
        // (incluimos "category" para que el widget sepa, en el momento, si
        // esta respuesta es una derivación a humano y pueda callar el aviso
        // de "¿te he resuelto las dudas?" sin esperar a que el agente conteste)
        res.json({
            products: finalProducts,
            text: aiContent.reply,
            isSizeContext: isSizeContext,
            category: newCategory
        });

    } catch (error) {
        console.error("❌ ERROR:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   📝 ENDPOINT PARA GUARDAR LOGS MANUALES (Feedback, Botones, etc.)
   ========================================================================== */
app.post("/api/chat/log", async (req, res) => {
    const { session_id, role, content } = req.body;

    if (!session_id || !role || !content) return res.status(400).json({ error: "Faltan datos" });

    // 🔒 Este endpoint no tiene login (lo llama el widget de forma anónima),
    // así que cualquiera que supiera un session_id podría escribir aquí.
    // Bloqueamos específicamente los marcadores de agente para que nadie
    // pueda falsificar una respuesta de agente o un cierre de derivación sin
    // pasar por /api/chat/agent-reply o /api/chat/agent-close (que sí exigen
    // el token de la sesión del visualizador).
    if (content.startsWith(AGENT_MARKER) || content.startsWith(AGENT_CLOSE_MARKER)) {
        return res.status(400).json({ error: "Contenido no permitido" });
    }

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

        console.log(`💾 Log manual guardado para sesión ${session_id}: ${content}`);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ Error guardando log manual:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   🧑‍💼 RESPUESTA DE AGENTE HUMANO (desde el visualizador interno)
   ==========================================================================
   Se guarda con role "assistant" (no "agent") a propósito: el historial de
   conversación se reenvía tal cual a OpenAI en cada turno (ver refineQuery y
   la llamada principal más arriba), y la API de OpenAI rechaza cualquier rol
   que no sea system/user/assistant/tool. Usamos un marcador de texto para
   que el widget y el visualizador sepan que ese mensaje "assistant" en
   realidad lo escribió una persona, no el modelo.
   ========================================================================== */

async function verifyAgentToken(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return false;
    const { data, error } = await supabase.auth.getUser(token);
    return !error && !!data?.user;
}

app.post("/api/chat/agent-reply", async (req, res) => {
    const { session_id, content } = req.body;
    if (!session_id || !content) return res.status(400).json({ error: "Faltan datos" });

    const authorized = await verifyAgentToken(req);
    if (!authorized) return res.status(401).json({ error: "No autorizado" });

    try {
        const { data: existing } = await supabase
            .from('chat_sessions')
            .select('conversation')
            .eq('session_id', session_id)
            .single();

        const history = (existing && existing.conversation) ? existing.conversation : [];
        history.push({
            role: 'assistant',
            content: AGENT_MARKER + content,
            timestamp: new Date().toISOString()
        });

        const { error } = await supabase
            .from('chat_sessions')
            .upsert({
                session_id: session_id,
                conversation: history,
                updated_at: new Date()
            });

        if (error) throw error;

        console.log(`🧑‍💼 Respuesta de agente guardada para sesión ${session_id}`);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ Error guardando respuesta de agente:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   🔓 DEVOLVER LA CONVERSACIÓN AL BOT (cerrar sesión de agente)
   ========================================================================== */
app.post("/api/chat/agent-close", async (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "Faltan datos" });

    const authorized = await verifyAgentToken(req);
    if (!authorized) return res.status(401).json({ error: "No autorizado" });

    try {
        const { data: existing } = await supabase
            .from('chat_sessions')
            .select('conversation')
            .eq('session_id', session_id)
            .single();

        const history = (existing && existing.conversation) ? existing.conversation : [];
        history.push({
            role: 'assistant',
            content: AGENT_CLOSE_MARKER + 'El agente ha cerrado la conversación. Si necesitas algo más, aquí estoy para ayudarte 😊',
            timestamp: new Date().toISOString()
        });

        const { error } = await supabase
            .from('chat_sessions')
            .upsert({
                session_id: session_id,
                conversation: history,
                updated_at: new Date()
            });

        if (error) throw error;

        console.log(`🔓 Conversación devuelta al bot: ${session_id}`);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ Error cerrando sesión de agente:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   🔄 POLLING DE NUEVOS MENSAJES
   ========================================================================== */
   // El widget pregunta esto cada pocos segundos mientras el chat está abierto,
   // para detectar respuestas de agente sin necesidad de recargar la página.
app.get("/api/chat/updates", async (req, res) => {
    const { session_id, count } = req.query;
    if (!session_id) return res.status(400).json({ error: "Falta session_id" });

    try {
        const { data, error } = await supabase
            .from('chat_sessions')
            .select('conversation')
            .eq('session_id', session_id)
            .single();

        if (error || !data) return res.json({ newMessages: [] });

        const known = parseInt(count, 10) || 0;
        const newMessages = (data.conversation || []).slice(known);
        res.json({ newMessages });

    } catch (error) {
        console.error("❌ Error en polling de updates:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

/* ==========================================================================
   🚀 INICIO DEL SERVIDOR
   ========================================================================== */
app.listen(PORT, async () => {
    console.log(`🚀 Server en http://localhost:${PORT}`);
    // Lanzamos la indexación en segundo plano (No usamos await para no bloquear el arranque en Render)
    loadIndexes().catch(err => console.error("⚠️ Error en carga inicial:", err));

});