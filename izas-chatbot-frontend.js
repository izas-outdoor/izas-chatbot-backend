/* ==========================================================================
   IZAS OUTDOOR — SCRIPT DEL CHATBOT (FRONTEND / THEME SHOPIFY)
   ==========================================================================
   VERSIÓN MEJORADA (seguridad + robustez):
   - Anti-XSS: todo el contenido dinámico se escapa antes de inyectarse.
   - sessionId con crypto.randomUUID() (con fallback).
   - Expiración real del historial guardado en localStorage (24h).
   - fetch con timeout real (AbortController) para no colgar la UI.
   - Listeners de scroll/resize con throttle (mejor rendimiento).
   - Placeholder de imagen propio (sin depender de via.placeholder.com).
   - Sin substr() deprecado.
   Mantiene los mismos IDs del DOM, así que es un reemplazo directo del script
   anterior; no hace falta tocar el HTML del theme.
   ========================================================================== */

/* ================== ESTADO GLOBAL ================== */
let chatHistory = [];
let visibleProductIds = [];
let sessionId = null;
let inactivityTimer;
let hasAskedFeedback = false;
let viewedProducts = []; // Array local de productos vistos

// ⚠️ IMPORTANTE: Si estás probando en local, usa http://localhost:3000
const BACKEND_URL = "https://izas-chatbot-backend.onrender.com";

// Caducidad del historial guardado (24h). Pasado ese tiempo, se empieza limpio.
const CHAT_STATE_TTL_MS = 24 * 60 * 60 * 1000;
// Timeout de las peticiones al backend (ms).
const FETCH_TIMEOUT_MS = 25000;
// Placeholder de imagen embebido (no depende de servicios externos).
const IMG_PLACEHOLDER = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="100%" height="100%" fill="#eef1f4"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#9aa5b1">Izas</text></svg>`
);

/* ================== UTILIDADES ================== */

// 🔐 Escapa HTML para evitar inyección de código (XSS) desde datos de producto,
//    respuestas del modelo o cualquier texto dinámico.
function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Genera un ID de sesión único y robusto.
function generateSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return "sess_" + window.crypto.randomUUID();
    }
    return "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 11);
}

// Throttle simple para listeners de scroll/resize.
function throttle(fn, wait) {
    let last = 0;
    let timer = null;
    return function (...args) {
        const now = Date.now();
        const remaining = wait - (now - last);
        if (remaining <= 0) {
            if (timer) { clearTimeout(timer); timer = null; }
            last = now;
            fn.apply(this, args);
        } else if (!timer) {
            timer = setTimeout(() => {
                last = Date.now();
                timer = null;
                fn.apply(this, args);
            }, remaining);
        }
    };
}

// fetch con timeout real mediante AbortController.
async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(id);
    }
}

/* ================== GESTIÓN DE ALMACENAMIENTO ================== */
function saveChatState() {
    const state = {
        history: chatHistory,
        sessionId: sessionId,
        visibleIds: visibleProductIds,
        timestamp: Date.now()
    };
    try {
        localStorage.setItem('izas_chat_state', JSON.stringify(state));
    } catch (e) {
        console.warn("No se pudo guardar el estado del chat:", e);
    }
}

function loadChatState() {
    const savedState = localStorage.getItem('izas_chat_state');

    // Cargar productos vistos independientemente del chat
    try {
        viewedProducts = JSON.parse(localStorage.getItem('izas_viewed_products')) || [];
    } catch (e) { viewedProducts = []; }

    if (!savedState) return false;

    try {
        const parsed = JSON.parse(savedState);

        // ⏳ Expiración: si el historial es más viejo que el TTL, empezamos limpio.
        if (!parsed.timestamp || (Date.now() - parsed.timestamp) > CHAT_STATE_TTL_MS) {
            localStorage.removeItem('izas_chat_state');
            return false;
        }

        sessionId = parsed.sessionId;
        chatHistory = parsed.history || [];
        visibleProductIds = parsed.visibleIds || [];

        const chatMessages = document.getElementById("chat-messages");
        if (chatMessages) {
            chatMessages.innerHTML = '';
            chatHistory.forEach(msg => {
                if (msg.role === 'user') {
                    renderUserMessage(msg.content);
                } else if (msg.role === 'assistant') {
                    renderBotMessage(msg.content);
                    if (msg.products && msg.products.length > 0) {
                        renderProductCards(msg.products);
                    }
                }
            });
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        return true;
    } catch (e) {
        console.error("Error cargando historial:", e);
        return false;
    }
}

/* ================== LOGS AL SERVIDOR ================== */
function logEventToBackend(role, content) {
    if (!sessionId) return;
    fetchWithTimeout(`${BACKEND_URL}/api/chat/log`, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, role: role, content: content })
    }).catch(err => console.error("Error guardando log:", err));
}

/* ================== NOTIFICACIONES ================== */
function showNotification() {
    const chatContainer = document.getElementById('chat-container');
    const dot = document.getElementById('notification-dot');
    if (chatContainer && !chatContainer.classList.contains('open') && dot) {
        dot.classList.add('visible');
    }
}

function clearNotification() {
    const dot = document.getElementById('notification-dot');
    if (dot) dot.classList.remove('visible');
}

/* ================== GESTIÓN DE HISTORIAL & PANEL LATERAL ================== */

// 1. Guardar visita si estamos en producto
function trackProductView() {
    if (!window.location.pathname.includes("/products/")) return;

    try {
        viewedProducts = JSON.parse(localStorage.getItem('izas_viewed_products')) || [];
    } catch (e) { viewedProducts = []; }

    const currentHandle = window.location.pathname.split("/products/")[1].split("?")[0];

    // Scraping básico
    const imgMeta = document.querySelector('meta[property="og:image"]');
    const titleMeta = document.querySelector('meta[property="og:title"]');
    const priceMeta = document.querySelector('meta[property="og:price:amount"]');

    // Fallbacks si no hay meta tags
    const domTitle = document.querySelector('h1')?.innerText;
    const domPrice = document.querySelector('.price, .product-price, .price__regular')?.innerText;

    const newProduct = {
        handle: currentHandle,
        image: imgMeta ? imgMeta.content : IMG_PLACEHOLDER,
        title: titleMeta ? titleMeta.content : (domTitle || "Producto"),
        price: priceMeta ? priceMeta.content + " €" : (domPrice || "Consultar"),
        timestamp: Date.now()
    };

    // Evitar duplicados y poner primero
    viewedProducts = viewedProducts.filter(p => p.handle !== currentHandle);
    viewedProducts.unshift(newProduct);
    if (viewedProducts.length > 10) viewedProducts.pop();

    try {
        localStorage.setItem('izas_viewed_products', JSON.stringify(viewedProducts));
    } catch (e) { /* almacenamiento lleno o bloqueado: lo ignoramos */ }
}

// 2. Renderizar el Panel Lateral
function renderSidePanelContent(selectedProduct = null) {
    if (!selectedProduct && viewedProducts.length > 0) {
        selectedProduct = viewedProducts[0];
    }
    if (!selectedProduct) return;

    // Actualizar Panel Principal
    const imgEls = document.querySelectorAll("#side-p-img");
    const titleEls = document.querySelectorAll("#side-p-title");
    const priceEls = document.querySelectorAll("#side-p-price");
    const btnEls = document.querySelectorAll(".side-cta");

    const updateDOM = (elements, value, type) => {
        elements.forEach(el => {
            if (type === 'src') el.src = value;
            else if (type === 'text') el.textContent = value;
            else if (type === 'link') el.onclick = () => window.location.href = `/products/${encodeURIComponent(value)}`;
        });
    };

    updateDOM(imgEls, selectedProduct.image, 'src');
    updateDOM(titleEls, selectedProduct.title, 'text');
    updateDOM(priceEls, selectedProduct.price, 'text');
    updateDOM(btnEls, selectedProduct.handle, 'link');

    // Actualizar Carrusel (construido con DOM, sin innerHTML de datos)
    const carouselContainer = document.getElementById("side-carousel");
    if (carouselContainer) {
        carouselContainer.innerHTML = "";
        viewedProducts.forEach(prod => {
            const thumb = document.createElement("div");
            thumb.className = `recent-thumb ${prod.handle === selectedProduct.handle ? 'active' : ''}`;
            const img = document.createElement("img");
            img.src = prod.image || IMG_PLACEHOLDER;
            img.alt = "thumb";
            img.onerror = function () { this.src = IMG_PLACEHOLDER; };
            thumb.appendChild(img);
            thumb.onclick = () => renderSidePanelContent(prod);
            carouselContainer.appendChild(thumb);
        });
    }

    // Clonar para móvil
    if (window.innerWidth <= 600) {
        const mobileContainer = document.getElementById("mobile-history-container");
        const pcContent = document.querySelector(".side-panel-content");

        if (mobileContainer && pcContent) {
            const contentClone = pcContent.cloneNode(true);
            const header = contentClone.querySelector(".side-header");
            if (header) header.style.display = "none";

            mobileContainer.innerHTML = "";
            mobileContainer.appendChild(contentClone);

            const mobileThumbs = mobileContainer.querySelectorAll(".recent-thumb");
            mobileThumbs.forEach((thumb, index) => {
                thumb.onclick = () => renderSidePanelContent(viewedProducts[index]);
            });
            const mobileBtn = mobileContainer.querySelector(".side-cta");
            if (mobileBtn) mobileBtn.onclick = () => window.location.href = `/products/${encodeURIComponent(selectedProduct.handle)}`;
        }
    }
}

/* ================== PESTAÑAS MÓVIL ================== */
window.switchMobileTab = function (tabName) {
    const chatView = document.getElementById("view-chat");
    const historyView = document.getElementById("view-history");
    const tabs = document.querySelectorAll(".mobile-tab");

    if (tabName === 'chat') {
        chatView.classList.add("active");
        historyView.classList.remove("active");
        tabs[0].classList.add("active");
        tabs[1].classList.remove("active");
    } else {
        chatView.classList.remove("active");
        historyView.classList.add("active");
        tabs[0].classList.remove("active");
        tabs[1].classList.add("active");
        renderSidePanelContent();
    }
};

/* ================== ABRIR / CERRAR UI ================== */
window.toggleSidePanel = function () {
    const panel = document.getElementById("side-product-panel");
    const chatContainer = document.getElementById("chat-container");
    const tab = document.getElementById("product-context-tab");

    if (!panel) return;

    const isVisible = panel.classList.contains("visible");

    if (isVisible) {
        panel.classList.remove("visible");
        if (tab) tab.classList.remove("open"); // Flecha IZQ
    } else {
        renderSidePanelContent();
        if (chatContainer && !chatContainer.classList.contains("open")) {
            toggleChat();
        }
        panel.classList.add("visible");
        if (tab) tab.classList.add("open"); // Flecha DER
    }
};

window.toggleChat = function () {
    const container = document.getElementById("chat-container");
    const floatingButton = document.querySelector(".hiddenchat");
    const panel = document.getElementById("side-product-panel");
    const tab = document.getElementById("product-context-tab");
    const htmlElement = document.documentElement;
    const bodyElement = document.body;

    if (!container) return;
    const isOpen = container.classList.contains('open');

    if (isOpen) {
        // CERRAR
        container.classList.remove('open');
        htmlElement.classList.remove('no-scroll');
        bodyElement.classList.remove('no-scroll');

        if (panel) panel.classList.remove("visible");
        if (tab) tab.classList.remove("open"); // Reset Flecha

        if (window.innerWidth <= 600 && floatingButton) floatingButton.style.display = "flex";

    } else {
        // ABRIR
        container.classList.add('open');
        htmlElement.classList.add('no-scroll');
        bodyElement.classList.add('no-scroll');

        if (panel) panel.classList.remove("visible");
        if (tab) tab.classList.remove("open");

        if (typeof clearNotification === "function") clearNotification();

        if (window.innerWidth <= 600 && floatingButton) floatingButton.style.display = "none";

        if (window.innerWidth > 600) {
            setTimeout(() => {
                const input = document.getElementById('user-input');
                if (input) input.focus();
            }, 100);
        }

        if (typeof chatHistory !== 'undefined' && chatHistory.length === 0) {
            if (!sessionId) sessionId = generateSessionId();
            fetchWithTimeout(`${BACKEND_URL}/api/chat/init`, {
                method: 'POST',
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId })
            })
                .then(res => res.json())
                .then(data => { addBotMessage(data.text); })
                .catch(err => {
                    console.error("Error init:", err);
                    addBotMessage("¡Hola! Soy el asistente experto de Izas. ¿En qué puedo ayudarte?");
                });
        }
    }
};

/* ================== MENSAJERÍA ================== */
function addBotMessage(text, products = null, isSizeContext = false, choices = null) {
    renderBotMessage(text);
    const messageEntry = { role: "assistant", content: text };

    if (products && products.length > 0) {
        messageEntry.products = products;
        renderProductCards(products, isSizeContext);
        visibleProductIds = products.map(p => p.id);
    }

    if (choices && choices.length > 0) renderChoiceButtons(choices);

    chatHistory.push(messageEntry);
    const chatMessages = document.getElementById("chat-messages");
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;

    saveChatState();
    showNotification();
    startInactivityTimer();
}

async function sendMessage() {
    const input = document.getElementById("user-input");
    const chatContainer = document.getElementById("chat-messages");
    if (!input || !chatContainer) return;

    const text = input.value.trim();
    if (!text) return;

    if (inactivityTimer) clearTimeout(inactivityTimer);
    hasAskedFeedback = false;

    renderUserMessage(text);
    chatHistory.push({ role: "user", content: text });
    input.value = "";
    saveChatState();

    const loading = document.createElement("div");
    loading.classList.add("message", "bot", "loading");
    loading.innerHTML = `<span></span><span></span><span></span>`;
    chatContainer.appendChild(loading);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    try {
        if (!sessionId) { sessionId = generateSessionId(); saveChatState(); }

        const apiUrl = `${BACKEND_URL}/api/ai/search`;
        const cleanHistory = chatHistory.map(({ role, content }) => ({ role, content }));

        let currentContextHandle = null;
        if (window.location.pathname.includes("/products/")) {
            const parts = window.location.pathname.split("/products/");
            if (parts.length > 1) currentContextHandle = parts[1].split("/")[0].split("?")[0];
        }

        const response = await fetchWithTimeout(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                q: text,
                history: cleanHistory.slice(0, -1),
                visible_ids: visibleProductIds,
                session_id: sessionId,
                context_handle: currentContextHandle
            })
        });

        const data = await response.json();
        loading.remove();
        if (!response.ok) throw new Error(data.error || "Error en el servidor");
        addBotMessage(data.text, data.products, data.isSizeContext, data.choices);

    } catch (err) {
        loading.remove();
        const msg = (err && err.name === "AbortError")
            ? "La respuesta está tardando demasiado. ¿Puedes intentarlo de nuevo?"
            : "Lo siento, he tenido un problema de conexión.";
        addBotMessage(msg);
    }
}

/* ================== RENDERIZADO VISUAL AUXILIAR ================== */
function renderUserMessage(text) {
    const div = document.createElement("div");
    div.className = "message user";
    div.textContent = text; // textContent => seguro contra XSS
    document.getElementById("chat-messages")?.appendChild(div);
}

function renderBotMessage(text) {
    const div = document.createElement("div");
    div.className = "message bot";
    div.innerHTML = formatMessage(text); // formatMessage escapa antes de formatear
    document.getElementById("chat-messages")?.appendChild(div);
}

// 🔐 FORMATO SEGURO: primero escapamos TODO el texto, y solo después aplicamos
//    el formato permitido (links, negritas, listas) sobre el texto ya escapado.
function formatMessage(text) {
    if (!text) return "";

    // 1. Escapamos el texto completo para neutralizar cualquier HTML/JS inyectado.
    let formatted = escapeHtml(text);

    // 2. Markdown Links [Texto](URL) — solo http/https.
    formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#0066cc; font-weight:bold;">$1</a>');

    // 3. URLs sueltas (que no formen ya parte de un enlace markdown).
    const rawUrlRegex = /(?<!["(])\bhttps?:\/\/[^\s<)]+/g;
    formatted = formatted.replace(rawUrlRegex, (url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#0066cc; text-decoration: underline;">${url}</a>`
    );

    // 4. Negritas, saltos de línea y viñetas.
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\n/g, '<br>');
    formatted = formatted.replace(/(^|<br>)- /g, '$1• ');

    return formatted;
}

function renderProductCards(products, isSizeContext = false) {
    const container = document.createElement("div");
    container.className = "carousel-container";

    products.forEach(p => {
        const card = document.createElement("div");
        card.className = "carousel-card";

        // Imagen
        const imageWrap = document.createElement("div");
        imageWrap.className = "card-image";
        const img = document.createElement("img");
        img.src = p.displayImage || p.image || IMG_PLACEHOLDER;
        img.alt = p.title || "Producto";
        img.onerror = function () { this.src = IMG_PLACEHOLDER; };
        imageWrap.appendChild(img);

        // Info
        const info = document.createElement("div");
        info.className = "card-info";

        const title = document.createElement("h4");
        title.textContent = p.title || "Producto";

        const price = document.createElement("p");
        price.className = "price";
        price.textContent = `${p.price ?? ""} €`;

        const button = document.createElement("button");
        button.textContent = isSizeContext ? 'Ver Tallas' : 'Ver Detalles';
        const urlParams = isSizeContext ? (p.displayUrlParams ? '&open_guide=true' : '?open_guide=true') : '';
        const handle = encodeURIComponent(p.handle || "");
        const extra = (p.displayUrlParams || "") + urlParams;
        button.onclick = () => window.open(`https://www.izas-outdoor.com/products/${handle}${extra}`, '_blank', 'noopener');

        info.appendChild(title);
        info.appendChild(price);
        info.appendChild(button);

        card.appendChild(imageWrap);
        card.appendChild(info);
        container.appendChild(card);
    });

    document.getElementById("chat-messages")?.appendChild(container);
}

function renderChoiceButtons(choices) {
    const chatMessages = document.getElementById("chat-messages");
    if (!chatMessages || !choices || choices.length === 0) return;

    const container = document.createElement("div");
    container.classList.add("choices-container");

    choices.forEach(choice => {
        const btn = document.createElement("button");
        btn.classList.add("choice-btn");
        btn.textContent = choice; // textContent => seguro
        btn.onclick = () => handleChoiceClick(choice, container);
        container.appendChild(btn);
    });

    chatMessages.appendChild(container);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function handleChoiceClick(text, container) {
    container.classList.add('disabled');
    const input = document.getElementById("user-input");
    input.value = text;
    sendMessage();
}

function startInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (hasAskedFeedback) return;

    inactivityTimer = setTimeout(() => {
        const chatContainer = document.getElementById('chat-container');
        if (chatContainer && chatContainer.classList.contains('open')) {
            const userHasSpoken = chatHistory.some(msg => msg.role === 'user');
            if (!userHasSpoken) return;
            const lastMsg = chatHistory[chatHistory.length - 1];
            if (lastMsg && lastMsg.content.includes("¿Te he resuelto las dudas?")) return;
            renderFeedbackMessage();
        }
    }, 20000);
}

function renderFeedbackMessage() {
    const chatMessages = document.getElementById("chat-messages");
    if (!chatMessages) return;

    const div = document.createElement("div");
    div.classList.add("message", "bot");
    div.innerHTML = `
        <div>¿Te he resuelto las dudas? 😊</div>
        <div class="feedback-buttons" id="feedback-actions">
            <button class="feedback-btn" onclick="handleFeedback('yes', this)">Sí, gracias</button>
            <button class="feedback-btn" onclick="handleFeedback('no', this)">No, necesito más ayuda</button>
        </div>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    const logText = "¿Te he resuelto las dudas? [Botones Mostrados]";
    chatHistory.push({ role: "assistant", content: logText });
    hasAskedFeedback = true;
    logEventToBackend('assistant', logText);
}

function handleFeedback(response, btnElement) {
    const container = btnElement.parentElement;
    container.classList.add('disabled');
    const buttons = container.querySelectorAll('button');
    buttons.forEach(btn => btn.onclick = null);

    let userResponseText = response === 'yes' ? "Sí, gracias" : "No, necesito más ayuda";
    let botReplyText = response === 'yes'
        ? "¡Genial! Me alegro de haberte ayudado. Aquí estoy si necesitas cualquier cosa más. 🏔️"
        : "Vaya, lo siento. 😔 Si necesitas ayuda más específica, puedes escribirnos a <b>info@izas-outdoor.com</b> o llamarnos al <b>976 50 20 40</b>.";

    logEventToBackend('user', userResponseText);
    setTimeout(() => { addBotMessage(botReplyText); }, 500);
}
window.handleFeedback = handleFeedback;

/* ================== INICIALIZACIÓN ================== */
document.addEventListener("DOMContentLoaded", function () {
    loadChatState();
    if (!sessionId) { sessionId = generateSessionId(); saveChatState(); }

    trackProductView();

    const tab = document.getElementById("product-context-tab");

    // Mostrar siempre si hay historial o estamos en PC
    if (window.innerWidth > 900 && tab) {
        if (viewedProducts.length > 0) {
            tab.style.display = "flex";
            renderSidePanelContent();
        }
    }

    const inputElement = document.getElementById("user-input");
    if (inputElement) {
        inputElement.addEventListener("keypress", (e) => {
            if (e.key === "Enter") { e.preventDefault(); sendMessage(); }
        });
    }

    function updateChatZIndex() {
        const fb = document.querySelector(".hiddenchat");
        const sb = document.getElementById("sticky-add-cart-container");
        const cc = document.getElementById("chat-container");
        if (!fb || !sb || !cc) return;
        const isMobile = window.innerWidth <= 600;
        const chatOpen = cc.classList.contains("open");
        const bannerStyle = getComputedStyle(sb);
        const bannerVisible = bannerStyle.display !== "none" && bannerStyle.opacity !== "0" && bannerStyle.visibility !== "hidden";

        if (bannerVisible) { fb.style.display = "none"; return; }

        if (isMobile) {
            if (chatOpen) fb.style.display = "none";
            else { fb.style.display = "flex"; fb.style.zIndex = "2147483000"; }
        } else {
            fb.style.display = "flex"; fb.style.zIndex = "2147483000";
        }
    }

    const throttledZIndex = throttle(updateChatZIndex, 150);
    updateChatZIndex();
    window.addEventListener("resize", throttledZIndex);
    window.addEventListener("scroll", throttledZIndex, { passive: true });
});

// Exponemos las funciones que el HTML del theme llama por onclick.
window.sendMessage = sendMessage;
