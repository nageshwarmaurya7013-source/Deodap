const APP_KEYS = {
  firebase: "deodap.firebaseConfig",
  firebaseOff: "deodap.firebaseOff",
}

const WORKSPACES = {
  deodap: {
    id: "deodap",
    name: "DeoDap",
    title: "DeoDap Orders",
    blurb: "Shopify cart JSON (test.json). Sale cards, favourites, View like cart review.",
    jsonHint: 'Shopify cart { "items": [ { "sku", "title", "price", "image", "product_description" } ] }. Unique id is sku. Prices are paise.',
    parse: "shopify",
    prefix: "deodap",
    features: { favourites: true, saleBadges: true, hsn: false, importFillsCart: false },
  },
  paarth: {
    id: "paarth",
    name: "Paarth",
    title: "Paarth Orders",
    blurb: "Order-sheet JSON: item_code, name, HSN, qty, rate in rupees. Import can fill the cart.",
    jsonHint: '{ "items": [ { "item_code", "name", "hsn", "qty", "rate", "mrp", "image" } ] }. Unique id is item_code / sku. Rate is rupees, not paise.',
    parse: "sheet",
    prefix: "paarth",
    features: { favourites: false, saleBadges: true, hsn: true, importFillsCart: true },
  },
}

let activeWorkspace = ""

function currentWs() {
  return WORKSPACES[activeWorkspace] || WORKSPACES.deodap
}

function keys() {
  const p = currentWs().prefix
  return {
    catalog: `${p}.catalog`,
    cart: `${p}.cart`,
    favs: `${p}.favs`,
    orders: `${p}.orders`,
    firebase: APP_KEYS.firebase,
    firebaseOff: APP_KEYS.firebaseOff,
  }
}

function path(to) {
  const id = currentWs().id
  if (!to || to === "/") return `#/${id}/`
  return `#/${id}/${String(to).replace(/^\//, "")}`
}

const rupees = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
})

const SAMPLE = [
  {
    sku: "6473_silicone_airpodes_cover",
    title: "Shockproof Silicone Wireless Headphones Carrying Case with Keychain",
    vendor: "PHOBIA",
    type: "mobile accessories",
    price: 1853,
    originalPrice: 1853,
    grams: 70,
    image: "https://cdn.shopify.com/s/files/1/0735/2300/3523/files/01_fe628cea-37f3-44d6-b9f2-7f68364e5464.jpg?v=1781671783",
    description: "Protect your wireless headphones with this shock-absorbing silicone carrying case.",
  },
]

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function save(key, value, syncCloud = true) {
  localStorage.setItem(key, JSON.stringify(value))
  if (syncCloud && key !== keys().firebase && key !== APP_KEYS.firebase && key !== APP_KEYS.firebaseOff) scheduleCloudWrite()
}

const cloud = {
  db: null,
  unsub: null,
  status: "local",
  error: "",
  projectId: "",
  writing: false,
  applying: false,
  timer: null,
}

function cloudLabel() {
  if (cloud.status === "live") return `Cloud connected · ${cloud.projectId}`
  if (cloud.status === "connecting") return "Connecting to Firebase…"
  if (cloud.status === "error") return `Firebase error · ${cloud.error}`
  return "Local only · this browser. GitHub does not save catalog, cart, or orders."
}

function explainFirebaseError(error) {
  const code = error?.code || ""
  const message = error instanceof Error ? error.message : String(error || "Could not connect to Firebase.")
  if (code === "permission-denied" || /permission/i.test(message)) {
    return "Firestore blocked the write. In Firebase Console → Firestore → Rules, publish allow read, write for /deodap/{document=**}, then click Connect again."
  }
  if (/NOT_FOUND|404|does not exist/i.test(message) || code === "not-found") {
    return "Firestore is not created yet. Firebase Console → Build → Firestore Database → Create database (test mode)."
  }
  if (/API has not been used|Cloud Firestore API is not available/i.test(message)) {
    return "Enable Cloud Firestore for this project, wait a minute, then connect again."
  }
  return message
}

function parseLooseObject(text) {
  const cleaned = String(text || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*/, "")
    .replace(/;+\s*$/, "")
  try {
    return JSON.parse(cleaned)
  } catch {}
  const quoted = cleaned.replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
  try {
    return JSON.parse(quoted)
  } catch {}
  throw new Error("Could not read that config. Paste the firebaseConfig { apiKey, projectId, ... } object.")
}

function parseFirebaseConfig(text) {
  let parsed = parseLooseObject(text)
  if (parsed && parsed.firebaseConfig) parsed = parsed.firebaseConfig
  if (!parsed || typeof parsed !== "object") throw new Error("Paste the Firebase web config object.")
  if (!parsed.apiKey || !parsed.projectId) throw new Error("Config must include apiKey and projectId.")
  return {
    apiKey: String(parsed.apiKey),
    authDomain: String(parsed.authDomain || `${parsed.projectId}.firebaseapp.com`),
    projectId: String(parsed.projectId),
    storageBucket: String(parsed.storageBucket || ""),
    messagingSenderId: String(parsed.messagingSenderId || ""),
    appId: String(parsed.appId || ""),
  }
}

function applyCloudState(data) {
  if (!data || typeof data !== "object") return
  cloud.applying = true
  if (Array.isArray(data.catalog)) save(keys().catalog, data.catalog, false)
  if (Array.isArray(data.cart)) save(keys().cart, data.cart, false)
  if (Array.isArray(data.favs)) save(keys().favs, data.favs, false)
  if (Array.isArray(data.orders)) save(keys().orders, data.orders, false)
  cloud.applying = false
}

async function pushCloudNow() {
  if (!cloud.db) return
  cloud.writing = true
  try {
    await cloud.db.collection(currentWs().prefix).doc("state").set({
      catalog: load(keys().catalog, []),
      cart: load(keys().cart, []),
      favs: load(keys().favs, []),
      orders: load(keys().orders, []),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    })
  } finally {
    setTimeout(() => {
      cloud.writing = false
    }, 500)
  }
}

function scheduleCloudWrite() {
  if (!cloud.db || cloud.applying) return
  clearTimeout(cloud.timer)
  cloud.timer = setTimeout(() => {
    pushCloudNow().catch((error) => {
      cloud.status = "error"
      cloud.error = explainFirebaseError(error)
      render()
    })
  }, 400)
}

function firebaseConfigToUse() {
  if (load(keys().firebaseOff, false)) return null
  const saved = load(keys().firebase, null)
  const baked = window.DEODAP_FIREBASE
  const raw = saved && saved.apiKey ? saved : baked
  if (!raw || !raw.apiKey) return null
  try {
    return parseFirebaseConfig(JSON.stringify(raw))
  } catch {
    return null
  }
}

async function connectFirebase() {
  const cfg = firebaseConfigToUse()
  if (!cfg || !cfg.apiKey) {
    cloud.status = "local"
    cloud.projectId = ""
    cloud.error = ""
    return
  }
  if (!window.firebase) {
    cloud.status = "error"
    cloud.error = "Firebase SDK did not load. Check the network."
    return
  }
  cloud.status = "connecting"
  cloud.projectId = cfg.projectId
  try {
    if (cloud.unsub) {
      cloud.unsub()
      cloud.unsub = null
    }
    if (firebase.apps.length) await firebase.app().delete()
    firebase.initializeApp(cfg)
    cloud.db = firebase.firestore()
    const ref = cloud.db.collection(currentWs().prefix).doc("state")
    const snap = await ref.get()
    if (snap.exists) applyCloudState(snap.data())
    else await pushCloudNow()
    cloud.unsub = ref.onSnapshot(
      (docSnap) => {
        if (!docSnap.exists || cloud.writing) return
        applyCloudState(docSnap.data())
        render()
      },
      (error) => {
        cloud.status = "error"
        cloud.error = explainFirebaseError(error)
        render()
      }
    )
    cloud.status = "live"
    cloud.error = ""
  } catch (error) {
    cloud.status = "error"
    cloud.error = explainFirebaseError(error)
    cloud.db = null
  }
}

async function saveFirebaseConfig(text) {
  const cfg = parseFirebaseConfig(text)
  localStorage.removeItem(keys().firebaseOff)
  localStorage.setItem(keys().firebase, JSON.stringify(cfg))
  await connectFirebase()
}

function disconnectFirebase() {
  if (cloud.unsub) cloud.unsub()
  cloud.unsub = null
  cloud.db = null
  cloud.status = "local"
  cloud.error = ""
  cloud.projectId = ""
  localStorage.setItem(keys().firebaseOff, JSON.stringify(true))
  localStorage.removeItem(keys().firebase)
  if (window.firebase && firebase.apps.length) firebase.app().delete().catch(() => {})
}

function repair(text) {
  const value = String(text || "")
  try {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 255)
    const decoded = new TextDecoder("utf-8").decode(bytes)
    if (!decoded.includes("\uFFFD") && decoded !== value) return decoded
  } catch {}
  return value
}

function decodeHtml(text) {
  const box = document.createElement("textarea")
  box.innerHTML = repair(text)
  return box.value
}

function skuFrom(raw) {
  const sku = String(raw.sku ?? raw.SKU ?? raw.Sku ?? "").trim()
  if (sku) return sku
  const handle = String(raw.handle ?? "").trim()
  const handleCode = (handle.match(/^(\d+)/) || [])[1] || ""
  if (handleCode) return handle
  const id = raw.variant_id ?? raw.product_id ?? raw.id
  return id != null ? String(id) : ""
}

function moneyMinor(raw) {
  const n = Number(raw.final_price ?? raw.price ?? raw.discounted_price ?? raw.presentment_price ?? 0)
  if (!Number.isFinite(n) || n < 0) return 0
  if (Number.isInteger(n) || n >= 100) return Math.round(n)
  return Math.round(n * 100)
}

function originalMinor(raw, sale) {
  const n = Number(raw.original_price ?? raw.compare_at_price ?? raw.mrp)
  if (!Number.isFinite(n) || n <= 0) return sale
  if (Number.isInteger(n) || n >= 100) return Math.round(n)
  return Math.round(n * 100)
}

function featuredImageUrl(raw) {
  const featured = raw.featured_image
  if (typeof featured === "string") return featured
  if (featured && typeof featured === "object") return featured.url || featured.src || ""
  return ""
}

function normalizeItem(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const sku = skuFrom(raw)
  if (!sku) return null
  const price = moneyMinor(raw)
  const title = decodeHtml(raw.product_title || raw.title || raw.name || "Untitled")
  const image = raw.image || featuredImageUrl(raw) || ""
  return {
    sku,
    title,
    vendor: decodeHtml(raw.vendor || raw.brand || ""),
    type: decodeHtml(raw.product_type || raw.type || ""),
    price,
    originalPrice: originalMinor(raw, price),
    grams: Number(raw.grams) || 0,
    image,
    description: decodeHtml(raw.product_description || raw.description || ""),
    handle: String(raw.handle || ""),
    index,
  }
}

function parseJsonText(text) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "").trim()
  if (!cleaned) throw new Error("Paste JSON first.")
  try {
    return JSON.parse(cleaned)
  } catch {}
  const objStart = cleaned.indexOf("{")
  const arrStart = cleaned.indexOf("[")
  const start = [objStart, arrStart].filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (start == null) throw new Error("That is not valid JSON.")
  const endObj = cleaned.lastIndexOf("}")
  const endArr = cleaned.lastIndexOf("]")
  const end = Math.max(endObj, endArr)
  if (end <= start) throw new Error("That is not valid JSON.")
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error("Could not parse that JSON. Use a Shopify cart file like test.json ({ \"items\": [...] }).")
  }
}

function extractItemRows(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== "object") return null
  if (Array.isArray(parsed.items)) return parsed.items
  if (parsed.cart && Array.isArray(parsed.cart.items)) return parsed.cart.items
  if (Array.isArray(parsed.line_items)) return parsed.line_items
  if (Array.isArray(parsed.products)) return parsed.products
  if (Array.isArray(parsed.rows)) return parsed.rows
  if (Array.isArray(parsed.order_items)) return parsed.order_items
  if (parsed.order && Array.isArray(parsed.order.items)) return parsed.order.items
  if (Array.isArray(parsed.data)) return parsed.data
  return null
}

function rupeesToMinor(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

function normalizeSheetItem(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const sku = String(raw.item_code || raw.sku || raw.code || raw.product_code || raw.ItemCode || "").trim()
  if (!sku) return null
  const price = rupeesToMinor(raw.rate ?? raw.price ?? raw.sale_price ?? raw.Amount)
  const mrp = rupeesToMinor(raw.mrp ?? raw.MRP ?? raw.original_price)
  return {
    sku,
    title: decodeHtml(raw.name || raw.product_name || raw.title || raw.item || "Untitled"),
    vendor: decodeHtml(raw.vendor || raw.brand || raw.party || "Paarth"),
    type: decodeHtml(raw.product_type || raw.category || raw.type || ""),
    price,
    originalPrice: mrp > price ? mrp : price,
    grams: Number(raw.grams) || 0,
    image: raw.image || featuredImageUrl(raw) || "",
    description: decodeHtml(raw.description || raw.product_description || ""),
    hsn: String(raw.hsn || raw.hsn_code || raw.HSN || ""),
    qtyHint: Math.max(0, Math.round(Number(raw.qty ?? raw.quantity ?? raw.Qty) || 0)),
    handle: String(raw.handle || ""),
    index,
  }
}

function parseCatalogJson(text) {
  const parsed = parseJsonText(text)
  const arr = extractItemRows(parsed)
  const sheet = currentWs().parse === "sheet"
  if (!arr) {
    throw new Error(sheet
      ? 'JSON must be an order sheet with "items" (item_code, name, rate, qty, hsn).'
      : 'JSON must match test.json: a Shopify cart with an "items" array, or a raw items array.')
  }
  const items = []
  const seen = new Set()
  arr.forEach((raw, index) => {
    const item = sheet ? normalizeSheetItem(raw, index) : normalizeItem(raw, index)
    if (!item || seen.has(item.sku)) return
    seen.add(item.sku)
    items.push(item)
  })
  if (!items.length) {
    throw new Error(sheet ? "No items with an item_code / sku were found." : "No items with a sku were found in that JSON.")
  }
  return items
}

let searchQ = ""

function state() {
  return {
    catalog: load(keys().catalog, currentWs().id === "deodap" ? SAMPLE : []),
    cart: load(keys().cart, []),
    favs: load(keys().favs, []),
    orders: load(keys().orders, []),
  }
}

function writeCatalog(catalog) {
  save(keys().catalog, catalog)
}

function writeCart(cart) {
  save(keys().cart, cart)
}

function writeFavs(favs) {
  save(keys().favs, favs)
}

function writeOrders(orders) {
  save(keys().orders, orders)
}

function route() {
  const hash = (location.hash || "#/").replace(/^#/, "")
  const parts = hash.split("/").filter(Boolean)
  if (!parts[0] || !WORKSPACES[parts[0]]) {
    activeWorkspace = ""
    return { name: "pick" }
  }
  activeWorkspace = parts[0]
  const rest = parts.slice(1)
  if (rest[0] === "item" && rest[1]) return { name: "item", sku: decodeURIComponent(rest[1]) }
  if (rest[0] === "cart") return { name: "cart" }
  if (rest[0] === "orders" && rest[1]) return { name: "order", id: decodeURIComponent(rest[1]) }
  if (rest[0] === "orders") return { name: "orders" }
  if (rest[0] === "favourites") return { name: "favourites" }
  if (rest[0] === "account") return { name: "account" }
  return { name: "home" }
}

function fmt(minor) {
  return rupees.format((Number(minor) || 0) / 100)
}

function salePct(item) {
  if (!item.originalPrice || item.originalPrice <= item.price) return 0
  return Math.round(((item.originalPrice - item.price) / item.originalPrice) * 100)
}

function cartQty(cart, sku) {
  const row = cart.find((line) => line.sku === sku)
  return row ? row.qty : 0
}

function setCartQty(sku, qty, catalog) {
  const item = catalog.find((row) => row.sku === sku)
  if (!item) return
  const cart = load(keys().cart, [])
  const nextQty = Math.max(0, Math.floor(Number(qty) || 0))
  const others = cart.filter((line) => line.sku !== sku)
  if (nextQty > 0) others.push({ sku, qty: nextQty })
  writeCart(others)
}

function toggleFav(sku) {
  const favs = load(keys().favs, [])
  writeFavs(favs.includes(sku) ? favs.filter((id) => id !== sku) : [...favs, sku])
}

function removeItem(sku) {
  writeCatalog(load(keys().catalog, []).filter((item) => item.sku !== sku))
  writeCart(load(keys().cart, []).filter((line) => line.sku !== sku))
  writeFavs(load(keys().favs, []).filter((id) => id !== sku))
}

function createOrder() {
  const data = state()
  const lines = data.cart
    .map((line) => {
      const item = data.catalog.find((row) => row.sku === line.sku)
      if (!item) return null
      return {
        sku: item.sku,
        title: item.title,
        vendor: item.vendor,
        type: item.type,
        image: item.image,
        price: item.price,
        qty: line.qty,
        line: item.price * line.qty,
      }
    })
    .filter(Boolean)
  if (!lines.length) return null
  const order = {
    id: "ORD-" + Date.now(),
    createdAt: new Date().toISOString(),
    items: lines,
    units: lines.reduce((sum, line) => sum + line.qty, 0),
    total: lines.reduce((sum, line) => sum + line.line, 0),
  }
  writeOrders([order, ...data.orders])
  writeCart([])
  return order
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]))
}

function productCard(item, { qty, fav }) {
  const pct = salePct(item)
  return `<article class="product" data-sku="${esc(item.sku)}">
    <div class="media">
      ${item.image ? `<img alt="" src="${esc(item.image)}" />` : ""}
      ${currentWs().features.saleBadges && pct ? `<span class="sale">Sale ${pct}%</span>` : ""}
      ${currentWs().features.favourites ? `<button class="heart ${fav ? "on" : ""}" data-act="fav" title="Favourite" aria-label="Favourite">♥</button>` : ""}
    </div>
    <div class="body">
      <div class="title">${esc(item.title)}</div>
      <div class="sku">${currentWs().parse === "sheet" ? "Code" : "SKU"} : ${esc(item.sku)}</div>
      ${currentWs().features.hsn && item.hsn ? `<div class="sku">HSN : ${esc(item.hsn)}</div>` : ""}
      <div class="prices">
        <span class="now">${fmt(item.price)}</span>
        ${item.originalPrice > item.price ? `<span class="was">${fmt(item.originalPrice)}</span>` : ""}
      </div>
      <div class="actions">
        <a class="btn ghost" href="${path("item/" + encodeURIComponent(item.sku))}">View</a>
        ${
          qty > 0
            ? `<div class="qty">
                <button data-act="dec">−</button>
                <input data-act="qty" type="number" min="1" step="1" value="${qty}" />
                <button data-act="inc">+</button>
              </div>`
            : `<button class="btn primary" data-act="add">Add to cart</button>`
        }
        <button class="btn danger" data-act="remove">Remove</button>
      </div>
    </div>
  </article>`
}

function reviewCards(items, qtyMap) {
  return items
    .map((item) => {
      const qty = qtyMap ? qtyMap[item.sku] ?? 1 : 1
      const line = item.price * qty
      return `<article class="card">
        ${item.image ? `<img class="thumb" alt="" src="${esc(item.image)}" />` : `<div class="thumb"></div>`}
        <div class="card-body">
          <div class="sku-lg">${currentWs().parse === "sheet" ? "Code" : "SKU"} : ${esc(item.sku)}</div>
          <div class="name">${esc(item.title)}</div>
          <div class="meta">${esc(item.vendor || "—")}${item.type ? ` · ${esc(item.type)}` : ""}${item.hsn ? ` · HSN ${esc(item.hsn)}` : ""}</div>
          <div class="card-prices">
            <span>Qty <strong>${qty}</strong></span>
            <span>Unit <strong>${fmt(item.price)}</strong></span>
            <span>Line <strong>${fmt(line)}</strong></span>
          </div>
          ${item.description ? `<div class="desc-block">
            <p class="desc">${esc(item.description)}</p>
            <button type="button" class="more-less">more</button>
          </div>` : ""}
        </div>
      </article>`
    })
    .join("")
}

function bindDescToggles(root) {
  root.querySelectorAll(".desc-block").forEach((block) => {
    const desc = block.querySelector(".desc")
    const btn = block.querySelector(".more-less")
    if (!desc || !btn) return
    const overflowing = desc.scrollHeight > desc.clientHeight + 2
    if (!overflowing) {
      btn.hidden = true
      return
    }
    btn.addEventListener("click", () => {
      const open = block.classList.toggle("open")
      btn.textContent = open ? "less" : "more"
    })
  })
}

function bindCatalog(root, catalog) {
  root.querySelectorAll(".product").forEach((card) => {
    const sku = card.dataset.sku
    card.addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]")
      if (!act) return
      event.preventDefault()
      const current = cartQty(load(keys().cart, []), sku)
      if (act.dataset.act === "fav") toggleFav(sku)
      if (act.dataset.act === "add") setCartQty(sku, 1, catalog)
      if (act.dataset.act === "inc") setCartQty(sku, current + 1, catalog)
      if (act.dataset.act === "dec") setCartQty(sku, current - 1, catalog)
      if (act.dataset.act === "remove") {
        if (confirm("Remove this item from the homepage list?")) removeItem(sku)
      }
      if (act.dataset.act === "qty") return
      render()
    })
    const qtyInput = card.querySelector("input[data-act=qty]")
    if (qtyInput) {
      qtyInput.addEventListener("change", () => {
        setCartQty(sku, qtyInput.value, catalog)
        render()
      })
    }
  })
}

function cartIcon() {
  return `<svg class="cart-ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6.2 6l.4 2h12.7a1 1 0 0 1 1 .8l1.2 6a1 1 0 0 1-1 1.2H8.1a1 1 0 0 1-1-.8L5.2 4H3V2h3.1a1 1 0 0 1 1 .8L7.2 4h13.3v2H6.2Z"/></svg>`
}

function cartSummary() {
  const catalog = load(keys().catalog, currentWs().id === "deodap" ? SAMPLE : [])
  const cart = load(keys().cart, [])
  let units = 0
  let total = 0
  cart.forEach((line) => {
    const item = catalog.find((row) => row.sku === line.sku)
    if (!item) return
    units += line.qty
    total += item.price * line.qty
  })
  return { units, total }
}

function navHtml(page) {
  const { units, total } = cartSummary()
  const favCount = load(keys().favs, []).length
  const cartLabel = `<span class="nav-cart">${cartIcon()}Cart${units ? `<span class="badge">${units}</span>` : ""}${total ? `<span class="nav-total">${fmt(total)}</span>` : ""}</span>`
  const links = [
    ["home", path("/"), "Home"],
    ["cart", path("cart"), cartLabel],
    ["orders", path("orders"), "Orders"],
  ]
  if (currentWs().features.favourites) {
    links.push(["favourites", path("favourites"), `Favourites${favCount ? `<span class="badge">${favCount}</span>` : ""}`])
  }
  links.push(["account", path("account"), "Account"])
  return links
    .map(([name, href, label]) => `<a class="${page === name || (page === "item" && name === "home") || (page === "order" && name === "orders") ? "on" : ""}" href="${href}">${label}</a>`)
    .join("")
}

function homePage(filterFavs = false) {
  const data = state()
  const q = searchQ.trim().toLowerCase()
  let items = filterFavs ? data.catalog.filter((item) => data.favs.includes(item.sku)) : data.catalog
  if (q) {
    items = items.filter((item) => [item.title, item.sku, item.vendor, item.type].join(" ").toLowerCase().includes(q))
  }
  return `
    <h1>${filterFavs ? "Favourites" : "Items"}</h1>
    <p class="sub">${filterFavs ? "Saved items from the homepage." : "Select an item, change quantity after adding to cart, or open View."}</p>
    <div class="toolbar">
      <input class="search" id="q" type="search" placeholder="Search name, SKU, vendor…" value="${esc(searchQ)}" />
      ${(() => {
        const { units, total } = cartSummary()
        return `<a class="cart-chip" href="${path("cart")}">${cartIcon()}<span>${fmt(total)}</span>${units ? `<span class="badge">${units}</span>` : ""}</a>`
      })()}
    </div>
    ${
      items.length
        ? `<section class="grid">${items.map((item) => productCard(item, { qty: cartQty(data.cart, item.sku), fav: data.favs.includes(item.sku) })).join("")}</section>`
        : `<p class="empty">${filterFavs ? "No favourites yet." : "No items yet. Import JSON from Account."}</p>`
    }
  `
}

function itemPage(sku) {
  const data = state()
  const item = data.catalog.find((row) => row.sku === sku)
  if (!item) return `<p class="empty">Item not found.</p>`
  const qty = Math.max(1, cartQty(data.cart, sku))
  const line = item.price * qty
  return `
    <p class="sub"><a href="${path("/")}">← Back to items</a></p>
    <h1>Cart review</h1>
    <p class="sub">Same layout as the test.html view.</p>
    <section class="review-stats">
      <article class="stat"><span>Products</span><strong>1</strong></article>
      <article class="stat"><span>Units</span><strong>${qty}</strong></article>
      <article class="stat"><span>Items total</span><strong>${fmt(line)}</strong></article>
      <article class="stat"><span>Unit</span><strong>${fmt(item.price)}</strong></article>
    </section>
    <section class="review-grid">${reviewCards([item], { [item.sku]: qty })}</section>
    <p class="actions" style="margin-top:16px">
      <button class="btn primary" data-add="${esc(item.sku)}">Add / keep in cart</button>
    </p>
  `
}

function cartPage() {
  const data = state()
  const lines = data.cart
    .map((line) => {
      const item = data.catalog.find((row) => row.sku === line.sku)
      return item ? { ...item, qty: line.qty, line: item.price * line.qty } : null
    })
    .filter(Boolean)
  const units = lines.reduce((sum, line) => sum + line.qty, 0)
  const total = lines.reduce((sum, line) => sum + line.line, 0)
  return `
    <h1>Cart</h1>
    <p class="sub">Create order saves these items and clears the cart.</p>
    <section class="review-stats">
      <article class="stat"><span>Products</span><strong>${lines.length}</strong></article>
      <article class="stat"><span>Units</span><strong>${units}</strong></article>
      <article class="stat"><span>Cart total</span><strong>${fmt(total)}</strong></article>
    </section>
    ${
      lines.length
        ? `<section class="review-grid">${reviewCards(lines, Object.fromEntries(lines.map((line) => [line.sku, line.qty])))}</section>
           <p class="actions" style="margin-top:16px"><button class="btn primary" id="create-order">Create order</button></p>`
        : `<p class="empty">Cart is empty.</p>`
    }
  `
}

function ordersPage() {
  const orders = load(keys().orders, [])
  return `
    <h1>Orders</h1>
    <p class="sub">Orders created from the cart.</p>
    ${
      orders.length
        ? orders
            .map(
              (order) => `<a class="order-row" href="${path("orders/" + encodeURIComponent(order.id))}">
                <div>
                  <strong>${esc(order.id)}</strong>
                  <div class="meta">${new Date(order.createdAt).toLocaleString("en-IN")} · ${order.items.length} products · ${fmt(order.total)}</div>
                </div>
              </a>`
            )
            .join("")
        : `<p class="empty">No orders yet.</p>`
    }
  `
}

function orderPage(id) {
  const order = load(keys().orders, []).find((row) => row.id === id)
  if (!order) return `<p class="empty">Order not found.</p>`
  return `
    <p class="sub"><a href="${path("orders")}">← All orders</a></p>
    <h1>${esc(order.id)}</h1>
    <p class="sub">${new Date(order.createdAt).toLocaleString("en-IN")}</p>
    <section class="review-stats">
      <article class="stat"><span>Products</span><strong>${order.items.length}</strong></article>
      <article class="stat"><span>Units</span><strong>${order.units}</strong></article>
      <article class="stat"><span>Total</span><strong>${fmt(order.total)}</strong></article>
    </section>
    <section class="review-grid">${reviewCards(order.items, Object.fromEntries(order.items.map((item) => [item.sku, item.qty])))}</section>
  `
}

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{brand}/{document=**} {
      allow read, write: if brand in ['deodap', 'paarth'];
    }
  }
}`

function pickerPage() {
  return `
    <h1>Choose a workspace</h1>
    <p class="sub">Each option has its own catalog, cart, orders, JSON format, and cloud folder.</p>
    <section class="picker-grid">
      ${Object.values(WORKSPACES).map((space) => `
        <button type="button" class="picker-card" data-workspace="${esc(space.id)}">
          <strong>${esc(space.name)}</strong>
          <span>${esc(space.blurb)}</span>
        </button>
      `).join("")}
    </section>
  `
}

const accountUi = {
  importPaste: "",
  addPaste: "",
  firebasePaste: "",
  importMsg: { className: "msg", text: "" },
  addMsg: { className: "msg", text: "" },
  firebaseMsg: { className: "msg", text: "" },
}

function accountPage() {
  const cfg = firebaseConfigToUse() || load(keys().firebase, null)
  const savedCfg = cfg ? JSON.stringify(cfg, null, 2) : accountUi.firebasePaste
  return `
    <h1>Account</h1>
    <p class="${cloud.status === "live" ? "cloud-pill live" : cloud.status === "error" ? "cloud-pill error" : "cloud-pill"}">${esc(cloudLabel())}</p>
    <p class="sub">${esc(currentWs().jsonHint)}</p>
    <div class="account-box">
      <section class="drop">
        <h2>Firebase (cloud save)</h2>
        <p class="meta">GitHub only hosts files. Catalog, cart, favourites, and orders live in this browser until you connect Firestore.</p>
        <ol class="guide">
          <li>Open <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">Firebase Console</a> and create a project (or pick one).</li>
          <li>Build → <strong>Firestore Database</strong> → Create database → start in <strong>test mode</strong>.</li>
          <li>Project settings (gear) → Your apps → Web (<strong>&lt;/&gt;</strong>) → copy the <code>firebaseConfig</code> object.</li>
          <li>Firestore → Rules → paste the rules below → Publish.</li>
          <li>Paste the config here and click <strong>Connect Firebase</strong>.</li>
        </ol>
        <pre class="rules">${esc(FIRESTORE_RULES)}</pre>
        <p class="meta">Anyone with this web app and these open rules can read/write <code>${esc(currentWs().prefix)}/state</code>. Lock this down with sign-in later.</p>
        <textarea id="firebase-paste" class="json-paste" spellcheck="false" placeholder='{ apiKey: "...", projectId: "...", appId: "..." }'>${esc(savedCfg)}</textarea>
        <button type="button" class="btn primary" id="firebase-connect">Connect Firebase</button>
        ${cfg ? `<button type="button" class="btn ghost" id="firebase-disconnect">Disconnect</button>` : ""}
        <p class="${esc(accountUi.firebaseMsg.className)}" id="firebase-msg">${esc(accountUi.firebaseMsg.text)}</p>
      </section>
      <section class="drop">
        <h2>Import JSON</h2>
        <p class="meta">Paste JSON and import. This replaces the ${esc(currentWs().name)} homepage list.${currentWs().features.importFillsCart ? " Qty in the JSON is added to the cart." : ""}</p>
        <textarea id="import-paste" class="json-paste" spellcheck="false" placeholder='Paste test.json here — Shopify cart with "items": [ { "sku": "...", "title": "...", "price": 1853, "image": "https://..." } ]'>${esc(accountUi.importPaste)}</textarea>
        <button type="button" class="btn primary" id="import-json">Import JSON</button>
        <p class="${esc(accountUi.importMsg.className)}" id="import-msg">${esc(accountUi.importMsg.text)}</p>
      </section>
      <section class="drop">
        <h2>Add JSON</h2>
        <p class="meta">Paste JSON and add. New SKUs are appended; existing SKUs are skipped.</p>
        <textarea id="add-paste" class="json-paste" spellcheck="false" placeholder='Paste JSON here'>${esc(accountUi.addPaste)}</textarea>
        <button type="button" class="btn primary" id="add-json">Add JSON</button>
        <p class="${esc(accountUi.addMsg.className)}" id="add-msg">${esc(accountUi.addMsg.text)}</p>
      </section>
    </div>
  `
}

function applyPastedJson(mode) {
  const pasteId = mode === "import" ? "import-paste" : "add-paste"
  const msgKey = mode === "import" ? "importMsg" : "addMsg"
  const pasteKey = mode === "import" ? "importPaste" : "addPaste"
  const text = (document.getElementById(pasteId)?.value || "").trim()
  accountUi[pasteKey] = text
  if (!text) {
    accountUi[msgKey] = { className: "msg err", text: "Paste JSON first." }
    render()
    return
  }
  try {
    const incoming = parseCatalogJson(text)
    const current = load(keys().catalog, [])
    if (mode === "import") {
      writeCatalog(incoming)
      if (currentWs().features.importFillsCart) {
        writeCart(incoming.filter((item) => item.qtyHint > 0).map((item) => ({ sku: item.sku, qty: item.qtyHint })))
      } else {
        writeCart(load(keys().cart, []).filter((line) => incoming.some((item) => item.sku === line.sku)))
      }
      writeFavs(load(keys().favs, []).filter((sku) => incoming.some((item) => item.sku === sku)))
      accountUi[msgKey] = {
        className: "msg ok",
        text: `Replaced homepage with ${incoming.length} unique SKU${incoming.length === 1 ? "" : "s"}.`,
      }
    } else {
      const have = new Set(current.map((item) => item.sku))
      const added = incoming.filter((item) => !have.has(item.sku))
      writeCatalog([...current, ...added])
      accountUi[msgKey] = {
        className: "msg ok",
        text: `Added ${added.length}. Skipped ${incoming.length - added.length} existing SKU${incoming.length - added.length === 1 ? "" : "s"}.`,
      }
    }
  } catch (error) {
    accountUi[msgKey] = {
      className: "msg err",
      text: error instanceof Error ? error.message : "Could not read that JSON.",
    }
  }
  render()
}

function render() {
  const page = route()
  const brand = document.getElementById("brand")
  const root = document.getElementById("page")
  document.title = page.name === "pick" ? "Orders" : currentWs().title
  if (brand) {
    brand.textContent = page.name === "pick" ? "Orders" : currentWs().title
    brand.href = "#/"
  }
  if (page.name === "pick") {
    document.getElementById("nav").innerHTML = ""
    root.innerHTML = pickerPage()
    root.querySelectorAll("[data-workspace]").forEach((button) => {
      button.addEventListener("click", () => {
        location.hash = `#/${button.dataset.workspace}/`
      })
    })
    return
  }
  document.getElementById("nav").innerHTML = navHtml(page.name)
  if (page.name === "item") root.innerHTML = itemPage(page.sku)
  else if (page.name === "cart") root.innerHTML = cartPage()
  else if (page.name === "orders") root.innerHTML = ordersPage()
  else if (page.name === "order") root.innerHTML = orderPage(page.id)
  else if (page.name === "favourites") root.innerHTML = homePage(true)
  else if (page.name === "account") root.innerHTML = accountPage()
  else root.innerHTML = homePage(false)

  const data = state()
  bindCatalog(root, data.catalog)
  bindDescToggles(root)

  const search = document.getElementById("q")
  if (search) {
    search.addEventListener("input", () => {
      searchQ = search.value
      render()
      const again = document.getElementById("q")
      if (again) {
        again.focus()
        try {
          const end = again.value.length
          again.setSelectionRange(end, end)
        } catch {}
      }
    })
  }

  const addKeep = root.querySelector("[data-add]")
  if (addKeep) {
    addKeep.addEventListener("click", () => {
      setCartQty(addKeep.dataset.add, Math.max(1, cartQty(load(keys().cart, []), addKeep.dataset.add)), data.catalog)
      location.hash = path("cart")
    })
  }

  const create = document.getElementById("create-order")
  if (create) {
    create.addEventListener("click", () => {
      const order = createOrder()
      if (!order) return
      location.hash = path("orders/" + encodeURIComponent(order.id))
    })
  }

  const importPaste = document.getElementById("import-paste")
  if (importPaste) importPaste.addEventListener("input", () => { accountUi.importPaste = importPaste.value })
  const addPaste = document.getElementById("add-paste")
  if (addPaste) addPaste.addEventListener("input", () => { accountUi.addPaste = addPaste.value })
  const importBtn = document.getElementById("import-json")
  if (importBtn) importBtn.addEventListener("click", () => applyPastedJson("import"))
  const addBtn = document.getElementById("add-json")
  if (addBtn) addBtn.addEventListener("click", () => applyPastedJson("add"))

  const firebasePaste = document.getElementById("firebase-paste")
  if (firebasePaste) firebasePaste.addEventListener("input", () => { accountUi.firebasePaste = firebasePaste.value })
  const firebaseConnect = document.getElementById("firebase-connect")
  if (firebaseConnect) {
    firebaseConnect.addEventListener("click", async () => {
      const text = (document.getElementById("firebase-paste")?.value || "").trim()
      accountUi.firebasePaste = text
      try {
        await saveFirebaseConfig(text)
        accountUi.firebaseMsg = {
          className: cloud.status === "live" ? "msg ok" : "msg err",
          text: cloud.status === "live"
            ? `Connected. ${currentWs().name} data is stored in the cloud (project ${cloud.projectId}, document ${currentWs().prefix}/state).`
            : cloud.error || "Could not connect.",
        }
      } catch (error) {
        accountUi.firebaseMsg = {
          className: "msg err",
          text: error instanceof Error ? error.message : "Invalid Firebase config.",
        }
      }
      render()
    })
  }
  const firebaseDisconnect = document.getElementById("firebase-disconnect")
  if (firebaseDisconnect) {
    firebaseDisconnect.addEventListener("click", () => {
      disconnectFirebase()
      accountUi.firebasePaste = ""
      accountUi.firebaseMsg = { className: "msg", text: "Disconnected. Data stays in this browser only." }
      render()
    })
  }
}

let cloudWorkspace = ""

function boot() {
  const page = route()
  render()
  if (page.name === "pick") return
  if (cloudWorkspace === activeWorkspace && (cloud.db || cloud.status === "error" || cloud.status === "live")) return
  cloudWorkspace = activeWorkspace
  connectFirebase().finally(() => render())
}

window.addEventListener("hashchange", boot)
boot()
