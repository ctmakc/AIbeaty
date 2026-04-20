const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT_DIR = path.join(__dirname, "..");
const DEMO_FILE = path.join(ROOT_DIR, "data", "demo-platform.json");
const DB_FILE = path.join(ROOT_DIR, "data", "platform.db");

const LIVE_SCREEN_FILES = {
  inventory: "inventory-management-luminous-core.html",
  automations: "automations-marketing-luminous-core.html",
  clients: "client-directory-luminous-core.html",
  inbox: "unified-inbox-luminous-core.html"
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readDemoPayload() {
  return JSON.parse(fs.readFileSync(DEMO_FILE, "utf8"));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createId(prefix, value) {
  const stem = slugify(value) || prefix;
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stem}-${Date.now().toString(36)}-${entropy}`;
}

function parseNumberLabel(label, fallbackUnit) {
  const match = String(label || "").match(/[\d.]+/);
  const quantity = match ? Number(match[0]) : 0;
  const unit = String(label || "").replace(/^[\d.\s]+/, "").trim() || fallbackUnit || "Units";
  return { quantity, unit };
}

function parseMoney(value, fallback = 0) {
  const parsed = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  })}`;
}

function formatDisplayDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric"
  });
}

function formatShortDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit"
  });
}

function normalizeClientStatus(status) {
  const label = String(status || "Regular").trim();
  const normalized = label.toLowerCase();
  if (normalized === "vip") return { status: "VIP", statusTone: "vip" };
  if (normalized === "new") return { status: "NEW", statusTone: "new" };
  if (normalized === "at-risk" || normalized === "atrisk") return { status: "AT-RISK", statusTone: "at-risk" };
  return { status: "REGULAR", statusTone: "regular" };
}

function titleCaseWords(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeQueryValue(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesQuery(term, values) {
  const normalized = normalizeQueryValue(term);
  if (!normalized) return true;
  return values.some((value) => normalizeQueryValue(value).includes(normalized));
}

function createPlatformStore() {
  const demo = readDemoPayload();
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  function runSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inventory_items (
        sku TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        icon TEXT NOT NULL,
        stock_quantity REAL NOT NULL,
        stock_unit TEXT NOT NULL,
        reorder_quantity REAL NOT NULL,
        reorder_unit TEXT NOT NULL,
        cost_value REAL NOT NULL,
        cost_label TEXT NOT NULL,
        stock_tone TEXT NOT NULL,
        category TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inventory_shipments (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        meta TEXT NOT NULL,
        time_label TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflows (
        name TEXT PRIMARY KEY,
        subtitle TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        action_text TEXT NOT NULL,
        sent TEXT NOT NULL,
        converted TEXT NOT NULL,
        conversion_rate TEXT NOT NULL,
        revenue TEXT NOT NULL,
        icon TEXT NOT NULL,
        tone TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_builder (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        trigger_text TEXT NOT NULL,
        action_text TEXT NOT NULL,
        message_text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS service_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        badge TEXT NOT NULL,
        icon TEXT NOT NULL,
        tone TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        processing_time_minutes INTEGER NOT NULL,
        price_label TEXT NOT NULL,
        price_value REAL NOT NULL,
        commission_rate INTEGER NOT NULL,
        description TEXT NOT NULL,
        online_booking_enabled INTEGER NOT NULL,
        requires_deposit INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stylists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        stylist_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        service_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        tone TEXT NOT NULL,
        start_minutes INTEGER NOT NULL,
        end_minutes INTEGER NOT NULL,
        badge TEXT NOT NULL,
        price_label TEXT NOT NULL,
        price_value REAL NOT NULL,
        active INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        notes TEXT NOT NULL,
        quiet_preference TEXT NOT NULL,
        history_json TEXT NOT NULL,
        since_label TEXT NOT NULL,
        checked_out INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        meta TEXT NOT NULL,
        time_label TEXT NOT NULL,
        icon TEXT NOT NULL,
        tone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        status_tone TEXT NOT NULL,
        last_visit TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL,
        avatar TEXT NOT NULL,
        ltv TEXT NOT NULL,
        visits_ytd TEXT NOT NULL,
        avg_ticket TEXT NOT NULL,
        formula_base TEXT NOT NULL,
        formula_highlights TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_preferences (
        client_id TEXT NOT NULL,
        value TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_history (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        service TEXT NOT NULL,
        date_label TEXT NOT NULL,
        stylist TEXT NOT NULL,
        amount TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_tone TEXT NOT NULL,
        time_label TEXT NOT NULL,
        preview TEXT NOT NULL,
        status TEXT NOT NULL,
        avatar TEXT NOT NULL,
        avatar_text TEXT NOT NULL,
        ltv TEXT NOT NULL,
        visits TEXT NOT NULL,
        visit_cadence TEXT NOT NULL,
        today_service TEXT NOT NULL,
        today_time TEXT NOT NULL,
        today_amount TEXT NOT NULL,
        today_stylist TEXT NOT NULL,
        contact_phone TEXT NOT NULL,
        contact_email TEXT NOT NULL,
        contact_preference TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_history (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        service TEXT NOT NULL,
        date_label TEXT NOT NULL,
        notes TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text_value TEXT NOT NULL,
        meta TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_suggestions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        text_value TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );
    `);
  }

  function ensureColumn(table, name, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name)) {
      try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
      } catch (error) {
        if (!error || !String(error.message || "").includes("duplicate column name")) {
          throw error;
        }
      }
    }
  }

  function runMigrations() {
    ensureColumn("appointments", "client_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("appointments", "service_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn("conversations", "client_id", "TEXT NOT NULL DEFAULT ''");
  }

  function touch(now = new Date().toISOString()) {
    db.prepare(`
      INSERT INTO metadata (key, value) VALUES ('last_updated', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(now);
    return now;
  }

  function getLastUpdated() {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_updated'").get();
    return row ? row.value : touch();
  }

  function clearLiveTables() {
    [
      "inventory_items",
      "inventory_shipments",
      "workflows",
      "automation_builder",
      "service_categories",
      "services",
      "stylists",
      "appointments",
      "activity_events",
      "clients",
      "client_preferences",
      "client_history",
      "conversations",
      "conversation_history",
      "conversation_messages",
      "conversation_suggestions",
      "metadata"
    ].forEach((table) => db.prepare(`DELETE FROM ${table}`).run());
  }

  function seedFromDemo() {
    const now = new Date().toISOString();
    clearLiveTables();

    const inventoryPage = demo.pages[LIVE_SCREEN_FILES.inventory];
    inventoryPage.items.forEach((item, index) => {
      const stock = parseNumberLabel(item.stock, "Units");
      const reorder = parseNumberLabel(item.reorderPoint, stock.unit);
      db.prepare(`
        INSERT INTO inventory_items (
          sku, name, brand, icon, stock_quantity, stock_unit, reorder_quantity, reorder_unit,
          cost_value, cost_label, stock_tone, category, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.sku,
        item.name,
        item.brand,
        item.icon,
        stock.quantity,
        stock.unit,
        reorder.quantity,
        reorder.unit,
        parseMoney(item.cost),
        item.cost,
        item.stockTone || "ok",
        item.category || "professional",
        index
      );
    });
    (inventoryPage.shipments || []).forEach((shipment, index) => {
      db.prepare(`
        INSERT INTO inventory_shipments (id, title, meta, time_label, status, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        createId("shipment", `${shipment.title}-${index}`),
        shipment.title,
        shipment.meta,
        shipment.time,
        shipment.status,
        index,
        now
      );
    });

    const automationsPage = demo.pages[LIVE_SCREEN_FILES.automations];
    automationsPage.workflows.forEach((workflow, index) => {
      db.prepare(`
        INSERT INTO workflows (
          name, subtitle, trigger_text, action_text, sent, converted, conversion_rate,
          revenue, icon, tone, enabled, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workflow.name,
        workflow.subtitle,
        workflow.trigger,
        workflow.action,
        workflow.sent,
        workflow.converted,
        workflow.conversionRate,
        workflow.revenue,
        workflow.icon,
        workflow.tone || "tertiary",
        workflow.enabled === false ? 0 : 1,
        index
      );
    });
    db.prepare(`
      INSERT INTO automation_builder (id, trigger_text, action_text, message_text)
      VALUES (1, ?, ?, ?)
    `).run(
      automationsPage.builder.trigger,
      automationsPage.builder.action,
      automationsPage.builder.message
    );

    const servicesPage = demo.pages["services-pricing-luminous-core.html"];
    servicesPage.categories.forEach((category, categoryIndex) => {
      const categoryId = createId("category", category.name);
      db.prepare(`
        INSERT INTO service_categories (id, name, badge, icon, tone, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(categoryId, category.name, category.badge, category.icon, category.tone || "primary", categoryIndex);
      category.services.forEach((service, serviceIndex) => {
        db.prepare(`
          INSERT INTO services (
            id, category_id, name, duration_minutes, processing_time_minutes, price_label, price_value,
            commission_rate, description, online_booking_enabled, requires_deposit, sort_order, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        `).run(
          createId("service", `${category.name}-${service.name}`),
          categoryId,
          service.name,
          Number(String(service.duration || "0").replace(/\D/g, "")) || 60,
          category.name === servicesPage.editor.category && service.name === servicesPage.editor.name
            ? Number(servicesPage.editor.processingTime || 0)
            : 0,
          service.price,
          parseMoney(service.price),
          Number(String(service.commission || "0").replace(/\D/g, "")) || 0,
          category.name === servicesPage.editor.category && service.name === servicesPage.editor.name
            ? servicesPage.editor.description
            : `${service.name} under ${category.name}.`,
          serviceIndex,
          now
        );
      });
    });

    const schedulePage = demo.pages["stylist-schedule-luminous-core.html"];
    schedulePage.stylists.forEach((stylist, index) => {
      db.prepare(`
        INSERT INTO stylists (id, name, role, avatar, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(createId("stylist", stylist.name), stylist.name, stylist.role, stylist.avatar, index);
    });
    const stylistRows = db.prepare(`SELECT id, name FROM stylists ORDER BY sort_order ASC`).all();
    schedulePage.appointments.forEach((appointment, index) => {
      const stylist = stylistRows[appointment.column];
      const timeMatch = String(appointment.time || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      const toMinutes = (hours, minutes, meridiem) => {
        let h = Number(hours);
        if (String(meridiem).toUpperCase() === "PM" && h !== 12) h += 12;
        if (String(meridiem).toUpperCase() === "AM" && h === 12) h = 0;
        return h * 60 + Number(minutes);
      };
      const startMinutes = timeMatch ? toMinutes(timeMatch[1], timeMatch[2], timeMatch[3]) : 9 * 60;
      const endMinutes = timeMatch ? toMinutes(timeMatch[4], timeMatch[5], timeMatch[6]) : startMinutes + 60;
      const selected = schedulePage.selectedAppointment;
      const isSelected = appointment.active === true || appointment.client === selected.client;
      db.prepare(`
      INSERT INTO appointments (
          id, stylist_id, client_id, service_id, service_name, client_name, avatar, tone, start_minutes, end_minutes, badge,
          price_label, price_value, active, tags_json, notes, quiet_preference, history_json,
          since_label, checked_out, sort_order, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        createId("appointment", `${appointment.client}-${appointment.service}`),
        stylist ? stylist.id : stylistRows[0].id,
        "",
        "",
        appointment.service,
        appointment.client,
        appointment.avatar || "",
        appointment.tone || "secondary",
        startMinutes,
        endMinutes,
        appointment.badge || "",
        appointment.price || (isSelected ? selected.amount : "$0"),
        parseMoney(appointment.price || (isSelected ? selected.amount : "$0")),
        isSelected ? 1 : 0,
        JSON.stringify(appointment.tags || (isSelected ? ["Active"] : [])),
        isSelected ? selected.notes : "",
        isSelected ? selected.quietPreference : "",
        JSON.stringify(isSelected ? selected.history : []),
        isSelected ? selected.since : "Client context pending",
        index,
        now
      );
    });

    const performancePage = demo.pages["salon-performance-luminous-core.html"];
    performancePage.activity.forEach((item, index) => {
      db.prepare(`
        INSERT INTO activity_events (id, title, meta, time_label, icon, tone, created_at, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        createId("activity", `${item.title}-${index}`),
        item.title,
        item.meta,
        item.time,
        item.icon,
        item.tone || "secondary",
        now,
        index
      );
    });

    const clientsPage = demo.pages[LIVE_SCREEN_FILES.clients];
    clientsPage.clients.forEach((client, index) => {
      db.prepare(`
        INSERT INTO clients (
          id, name, status, status_tone, last_visit, phone, email, avatar, ltv, visits_ytd,
          avg_ticket, formula_base, formula_highlights, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        client.id,
        client.name,
        client.status,
        client.statusTone,
        client.lastVisit,
        client.phone,
        client.email,
        client.avatar || "",
        client.ltv,
        client.visitsYtd,
        client.avgTicket,
        client.formulaBase,
        client.formulaHighlights,
        index,
        now,
        now
      );
      (client.preferences || []).forEach((preference, prefIndex) => {
        db.prepare(`
          INSERT INTO client_preferences (client_id, value, sort_order) VALUES (?, ?, ?)
        `).run(client.id, preference, prefIndex);
      });
      (client.history || []).forEach((historyItem, historyIndex) => {
        db.prepare(`
          INSERT INTO client_history (id, client_id, service, date_label, stylist, amount, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          createId("client-history", `${client.id}-${historyIndex}`),
          client.id,
          historyItem.service,
          historyItem.date,
          historyItem.stylist,
          historyItem.amount,
          historyIndex
        );
      });
    });

    const inboxPage = demo.pages[LIVE_SCREEN_FILES.inbox];
    inboxPage.conversations.forEach((conversation, index) => {
      db.prepare(`
      INSERT INTO conversations (
        id, client_id, name, channel, channel_tone, time_label, preview, status, avatar, avatar_text, ltv,
        visits, visit_cadence, today_service, today_time, today_amount, today_stylist,
        contact_phone, contact_email, contact_preference, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversation.id,
        "",
        conversation.name,
        conversation.channel,
        conversation.channelTone || conversation.channel.toLowerCase(),
        conversation.time,
        conversation.preview,
        conversation.status,
        conversation.avatar || "",
        conversation.avatarText || "",
        conversation.ltv,
        conversation.visits,
        conversation.visitCadence,
        conversation.todayVisit.service,
        conversation.todayVisit.time,
        conversation.todayVisit.amount,
        conversation.todayVisit.stylist,
        conversation.contact.phone,
        conversation.contact.email,
        conversation.contact.preference,
        index,
        now,
        now
      );
      (conversation.history || []).forEach((historyItem, historyIndex) => {
        db.prepare(`
          INSERT INTO conversation_history (id, conversation_id, service, date_label, notes, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          createId("conversation-history", `${conversation.id}-${historyIndex}`),
          conversation.id,
          historyItem.service,
          historyItem.date,
          historyItem.notes,
          historyIndex
        );
      });
      (conversation.messages || []).forEach((message, messageIndex) => {
        db.prepare(`
          INSERT INTO conversation_messages (id, conversation_id, type, text_value, meta, sort_order, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          createId("message", `${conversation.id}-${messageIndex}`),
          conversation.id,
          message.type,
          message.text,
          message.meta || "",
          messageIndex,
          now
        );
      });
      (conversation.suggestions || []).forEach((suggestion, suggestionIndex) => {
        db.prepare(`
          INSERT INTO conversation_suggestions (id, conversation_id, text_value, sort_order)
          VALUES (?, ?, ?, ?)
        `).run(
          createId("suggestion", `${conversation.id}-${suggestionIndex}`),
          conversation.id,
          suggestion,
          suggestionIndex
        );
      });
    });

    repairMissingEntityLinks();
    touch(now);
  }

  function ensureSeeded() {
    const checks = [
      "clients",
      "inventory_items",
      "workflows",
      "services",
      "stylists",
      "appointments",
      "conversations"
    ];
    const needsSeed = checks.some((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return !row || row.count === 0;
    });
    if (needsSeed) seedFromDemo();
  }

  function getServiceById(id) {
    return db.prepare(`
      SELECT s.*, c.name AS category_name
      FROM services s
      JOIN service_categories c ON c.id = s.category_id
      WHERE s.id = ?
    `).get(id);
  }

  function getServiceByName(name) {
    return db.prepare(`
      SELECT s.*, c.name AS category_name
      FROM services s
      JOIN service_categories c ON c.id = s.category_id
      WHERE lower(s.name) = lower(?)
      ORDER BY s.updated_at DESC
      LIMIT 1
    `).get(name);
  }

  function getClientRecordById(id) {
    return db.prepare(`SELECT * FROM clients WHERE id = ?`).get(id);
  }

  function findClientRecord(input, options = {}) {
    const allowPhoneMatch = options.allowPhoneMatch !== false;
    if (input.clientId) {
      const byId = getClientRecordById(input.clientId);
      if (byId) return byId;
    }
    if (input.email) {
      const byEmail = db.prepare(`SELECT * FROM clients WHERE lower(email) = lower(?)`).get(input.email);
      if (byEmail) return byEmail;
    }
    if (allowPhoneMatch && input.phone) {
      const byPhone = db.prepare(`SELECT * FROM clients WHERE phone = ?`).get(input.phone);
      if (byPhone) return byPhone;
    }
    if (input.name) {
      const byName = db.prepare(`SELECT * FROM clients WHERE lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1`).get(input.name);
      if (byName) return byName;
    }
    return null;
  }

  function createImplicitClient(input) {
    const clientId = createClient({
      name: input.name || "Walk-in Client",
      email: input.email || "pending@client.local",
      phone: input.phone || "(555) 000-0000",
      status: input.status || "NEW",
      preferences: input.preferences || "",
      lastVisit: "First visit scheduled"
    });
    return getClientRecordById(clientId);
  }

  function resolveClientForAppointment(input, options = {}) {
    return findClientRecord(input, options) || createImplicitClient(input);
  }

  function syncConversationFromEntities(conversationId) {
    const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
    if (!conversation) return null;
    const client = conversation.client_id ? getClientRecordById(conversation.client_id) : null;
    db.prepare(`
      UPDATE conversations
      SET name = ?, avatar = ?, contact_phone = ?, contact_email = ?, ltv = ?, visits = ?, updated_at = ?
      WHERE id = ?
    `).run(
      client ? client.name : conversation.name,
      client ? client.avatar : conversation.avatar,
      client ? client.phone : conversation.contact_phone,
      client ? client.email : conversation.contact_email,
      client ? client.ltv : conversation.ltv,
      client ? client.visits_ytd : conversation.visits,
      new Date().toISOString(),
      conversationId
    );
    return conversationId;
  }

  function repairMissingEntityLinks() {
    const now = new Date().toISOString();
    db.prepare(`
      SELECT id, client_name
      FROM appointments
      WHERE client_id IS NULL OR client_id = ''
      ORDER BY sort_order ASC, updated_at DESC
    `).all().forEach((appointment) => {
      const client = resolveClientForAppointment({
        name: appointment.client_name
      }, { allowPhoneMatch: false });
      if (!client) return;
      db.prepare(`
        UPDATE appointments
        SET client_id = ?, updated_at = ?
        WHERE id = ?
      `).run(client.id, now, appointment.id);
      syncAppointmentFromEntities(appointment.id);
    });

    db.prepare(`
      SELECT id, name, contact_email
      FROM conversations
      WHERE client_id IS NULL OR client_id = ''
      ORDER BY sort_order ASC, updated_at DESC
    `).all().forEach((conversation) => {
      const client = resolveClientForAppointment({
        name: conversation.name,
        email: conversation.contact_email
      }, { allowPhoneMatch: false });
      if (!client) return;
      db.prepare(`
        UPDATE conversations
        SET client_id = ?, updated_at = ?
        WHERE id = ?
      `).run(client.id, now, conversation.id);
      syncConversationFromEntities(conversation.id);
    });
  }

  function buildClientHistoryPreview(clientId) {
    return getClientHistory(clientId).slice(0, 3);
  }

  function buildSinceLabel(client) {
    if (!client) return "Client context pending";
    if (client.status_tone === "vip") return "Since Oct 2021 • VIP";
    if (client.status_tone === "new") return "New client";
    return "Recent client";
  }

  function withLiveQuery(page, liveQuery = {}) {
    page.liveQuery = liveQuery;
    return page;
  }

  function getActivityEntries(options = {}) {
    const limit = Math.max(1, Number(options.limit) || 6);
    const search = String(options.q || "").trim();
    return db.prepare(`
      SELECT title, meta, time_label, icon, tone
      FROM activity_events
      ORDER BY sort_order ASC, created_at DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      title: row.title,
      meta: row.meta,
      time: row.time_label,
      icon: row.icon,
      tone: row.tone
    })).filter((row) => matchesQuery(search, [row.title, row.meta, row.time, row.icon, row.tone]));
  }

  function getBasePage(screenFile) {
    return clone(demo.pages[screenFile] || {});
  }

  function getInventoryItems() {
    return db.prepare(`
      SELECT sku, name, brand, icon, stock_quantity, stock_unit, reorder_quantity, reorder_unit,
             cost_label, stock_tone, category
      FROM inventory_items
      ORDER BY sort_order ASC, name ASC
    `).all().map((row) => ({
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      icon: row.icon,
      stock: `${row.stock_quantity} ${row.stock_unit}`,
      reorderPoint: `${row.reorder_quantity} ${row.reorder_unit}`,
      cost: row.cost_label,
      stockTone: row.stock_tone,
      category: row.category
    }));
  }

  function getInventoryPage(options = {}) {
    const page = getBasePage(LIVE_SCREEN_FILES.inventory);
    const category = normalizeQueryValue(options.category) || "professional";
    const stock = normalizeQueryValue(options.stock) || "all";
    const search = String(options.q || "").trim();
    page.items = getInventoryItems().filter((item) => (
      (!category || item.category === category) &&
      (stock === "all" || item.stockTone === stock) &&
      matchesQuery(search, [item.name, item.brand, item.sku, item.category, item.stockTone])
    ));
    page.shipments = db.prepare(`
      SELECT title, meta, time_label, status
      FROM inventory_shipments
      ORDER BY sort_order ASC, created_at DESC
      LIMIT 6
    `).all().map((row) => ({
      title: row.title,
      meta: row.meta,
      time: row.time_label,
      status: row.status
    }));

    const totalValue = db.prepare(`
      SELECT COALESCE(SUM(stock_quantity * cost_value), 0) AS total_value FROM inventory_items
    `).get().total_value;
    const lowCount = db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_items WHERE stock_tone = 'low'
    `).get().count;
    const totalProducts = db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_items
    `).get().count;

    if (Array.isArray(page.kpis)) {
      if (page.kpis[0]) page.kpis[0].value = formatMoney(totalValue);
      if (page.kpis[1]) {
        page.kpis[1].value = String(lowCount);
        page.kpis[1].detail = lowCount ? "Requires immediate action" : "Stock is within target levels";
      }
      if (page.kpis[2]) page.kpis[2].value = String(totalProducts);
    }

    return withLiveQuery(page, { q: search, category, stock });
  }

  function getWorkflows() {
    return db.prepare(`
      SELECT name, subtitle, trigger_text, action_text, sent, converted, conversion_rate,
             revenue, icon, tone, enabled
      FROM workflows
      ORDER BY sort_order ASC, name ASC
    `).all().map((row) => ({
      name: row.name,
      subtitle: row.subtitle,
      trigger: row.trigger_text,
      action: row.action_text,
      sent: row.sent,
      converted: row.converted,
      conversionRate: row.conversion_rate,
      revenue: row.revenue,
      icon: row.icon,
      tone: row.tone,
      enabled: Boolean(row.enabled)
    }));
  }

  function getAutomationsPage(options = {}) {
    const page = getBasePage(LIVE_SCREEN_FILES.automations);
    const search = String(options.q || "").trim();
    const enabled = normalizeQueryValue(options.enabled) || "all";
    page.workflows = getWorkflows().filter((workflow) => (
      (enabled === "all" ||
        (enabled === "enabled" && workflow.enabled !== false) ||
        (enabled === "disabled" && workflow.enabled === false)) &&
      matchesQuery(search, [workflow.name, workflow.subtitle, workflow.trigger, workflow.action])
    ));
    const builder = db.prepare(`
      SELECT trigger_text, action_text, message_text FROM automation_builder WHERE id = 1
    `).get();
    if (builder) {
      page.builder = {
        trigger: builder.trigger_text,
        action: builder.action_text,
        message: builder.message_text
      };
    }
    page.summaryBadge = `${page.workflows.filter((workflow) => workflow.enabled !== false).length} Running`;
    return withLiveQuery(page, { q: search, enabled });
  }

  function logActivity(entry) {
    db.prepare(`UPDATE activity_events SET sort_order = sort_order + 1`).run();
    db.prepare(`
      INSERT INTO activity_events (id, title, meta, time_label, icon, tone, created_at, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      createId("activity", entry.title),
      entry.title,
      entry.meta,
      entry.time || "Just now",
      entry.icon || "bolt",
      entry.tone || "secondary",
      new Date().toISOString()
    );
  }

  function getServiceCategories() {
    const categories = db.prepare(`
      SELECT id, name, badge, icon, tone FROM service_categories ORDER BY sort_order ASC
    `).all();
    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      badge: category.badge,
      icon: category.icon,
      tone: category.tone,
      services: db.prepare(`
        SELECT id, name, duration_minutes, price_label, commission_rate
        FROM services
        WHERE category_id = ?
        ORDER BY sort_order ASC, name ASC
      `).all(category.id).map((service) => ({
        id: service.id,
        name: service.name,
        duration: `${service.duration_minutes} min`,
        price: service.price_label,
        commission: `${service.commission_rate}%`
      }))
    }));
  }

  function getServicesPage() {
    const page = getBasePage("services-pricing-luminous-core.html");
    page.categories = getServiceCategories();
    const editorService = db.prepare(`
      SELECT s.id, s.name, s.duration_minutes, s.processing_time_minutes, s.price_value, s.commission_rate, s.description,
             c.name AS category_name
      FROM services s
      JOIN service_categories c ON c.id = s.category_id
      ORDER BY s.updated_at DESC, c.sort_order ASC, s.sort_order ASC
      LIMIT 1
    `).get();
    if (editorService) {
      page.editor = {
        id: editorService.id,
        name: editorService.name,
        category: editorService.category_name,
        description: editorService.description,
        duration: String(editorService.duration_minutes),
        processingTime: String(editorService.processing_time_minutes),
        price: editorService.price_value.toFixed(2),
        commission: String(editorService.commission_rate)
      };
    }
    return page;
  }

  function getStylistRows() {
    return db.prepare(`
      SELECT id, name, role, avatar FROM stylists ORDER BY sort_order ASC
    `).all();
  }

  function minutesToTop(minutes) {
    return Math.max(0, (minutes - 540) * 1.6);
  }

  function formatTimeRange(startMinutes, endMinutes) {
    function formatOne(totalMinutes) {
      const hours24 = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      const meridiem = hours24 >= 12 ? "PM" : "AM";
      const hours12 = hours24 % 12 || 12;
      return `${hours12}:${String(mins).padStart(2, "0")} ${meridiem}`;
    }
    return `${formatOne(startMinutes)} - ${formatOne(endMinutes)}`;
  }

  function parseClockLabel(value, fallbackMinutes) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
    if (!match) return fallbackMinutes;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = match[3] ? match[3].toUpperCase() : "";
    if (meridiem === "PM" && hours !== 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  function getAppointmentRows() {
    const stylists = getStylistRows();
    const stylistIndex = new Map(stylists.map((stylist, index) => [stylist.id, index]));
    return db.prepare(`
      SELECT a.*, c.avatar AS client_avatar, c.status AS client_status, c.status_tone AS client_status_tone,
             c.last_visit AS client_last_visit
      FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE checked_out = 0
      ORDER BY start_minutes ASC, sort_order ASC
    `).all().map((row) => ({
      id: row.id,
      column: stylistIndex.get(row.stylist_id) || 0,
      top: minutesToTop(row.start_minutes),
      height: Math.max(72, (row.end_minutes - row.start_minutes) * 1.6),
      tone: row.tone,
      service: row.service_name,
      price: row.price_label,
      time: formatTimeRange(row.start_minutes, row.end_minutes),
      client: row.client_name,
      avatar: row.client_avatar || row.avatar,
      badge: row.badge || undefined,
      tags: JSON.parse(row.tags_json || "[]"),
      active: Boolean(row.active),
      stylistId: row.stylist_id,
      clientId: row.client_id,
      serviceId: row.service_id,
      notes: row.notes,
      quietPreference: row.quiet_preference,
      history: JSON.parse(row.history_json || "[]"),
      since: row.since_label,
      clientStatus: row.client_status || "",
      clientStatusTone: row.client_status_tone || ""
    }));
  }

  function mapSelectedAppointment(row) {
    return {
      id: row.id,
      client: row.client_name,
      since: row.since_label,
      service: row.service_name,
      time: formatTimeRange(row.start_minutes, row.end_minutes),
      stylist: row.stylist_name,
      amount: row.price_label,
      clientId: row.client_id,
      serviceId: row.service_id,
      avatar: row.client_avatar || row.avatar,
      status: row.client_status || "",
      statusTone: row.client_status_tone || "",
      notes: row.notes,
      quietPreference: row.quiet_preference,
      history: JSON.parse(row.history_json || "[]")
    };
  }

  function selectByRequestedId(items, requestedId, matcher, fallbackToFirst = true) {
    const normalizedId = String(requestedId || "").trim();
    if (!Array.isArray(items) || !items.length) return "";
    if (normalizedId && items.some((item) => item && item.id === normalizedId)) return normalizedId;
    if (typeof matcher === "function") {
      const matched = items.find((item) => item && matcher(item));
      if (matched && matched.id) return matched.id;
    }
    return fallbackToFirst ? items[0].id : "";
  }

  function getSelectedAppointment(filteredAppointments, requestedAppointmentId, fallbackToGlobal = true) {
    const selectedAppointmentId = String(requestedAppointmentId || "").trim();
    if (selectedAppointmentId) {
      const selectedRow = db.prepare(`
        SELECT a.*, s.name AS stylist_name, c.avatar AS client_avatar, c.status AS client_status,
               c.status_tone AS client_status_tone
        FROM appointments a
        JOIN stylists s ON s.id = a.stylist_id
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.id = ?
        LIMIT 1
      `).get(selectedAppointmentId);
      return selectedRow ? mapSelectedAppointment(selectedRow) : null;
    }
    if (!fallbackToGlobal) return null;
    const row = db.prepare(`
      SELECT a.*, s.name AS stylist_name, c.avatar AS client_avatar, c.status AS client_status,
             c.status_tone AS client_status_tone
      FROM appointments a
      JOIN stylists s ON s.id = a.stylist_id
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.checked_out = 0
      ORDER BY a.active DESC, a.updated_at DESC, a.sort_order ASC
      LIMIT 1
    `).get();
    if (!row) return null;
    return mapSelectedAppointment(row);
  }

  function getSchedulePage(options = {}) {
    const page = getBasePage("stylist-schedule-luminous-core.html");
    const search = String(options.q || "").trim();
    const stylist = normalizeQueryValue(options.stylist) || "all";
    const clientId = String(options.clientId || "").trim();
    const appointmentId = String(options.appointmentId || "").trim();
    page.stylists = getStylistRows().map((stylist) => ({
      name: stylist.name,
      role: stylist.role,
      avatar: stylist.avatar
    }));
    page.appointments = getAppointmentRows().filter((appointment) => (
      (stylist === "all" || normalizeQueryValue(page.stylists[appointment.column] && page.stylists[appointment.column].name) === stylist) &&
      matchesQuery(search, [appointment.client, appointment.service, appointment.price, appointment.time, appointment.since, appointment.clientStatus, page.stylists[appointment.column] && page.stylists[appointment.column].name])
    ));
    page.selectedAppointment = getSelectedAppointment(
      page.appointments,
      selectByRequestedId(
        page.appointments,
        appointmentId,
        (appointment) => appointment.clientId === clientId,
        clientId ? false : true
      ),
      clientId ? false : true
    );
    return withLiveQuery(page, { q: search, stylist, clientId, appointmentId });
  }

  function getPerformancePage(options = {}) {
    const page = getBasePage("salon-performance-luminous-core.html");
    const search = String(options.q || "").trim();
    const limit = Math.max(1, Number(options.limit) || 6);
    const appointmentStats = db.prepare(`
      SELECT COUNT(*) AS appointments,
             COALESCE(SUM(price_value), 0) AS revenue
      FROM appointments
    `).get();
    const clientsCount = db.prepare(`SELECT COUNT(*) AS count FROM clients`).get().count;
    const conversationsCount = db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get().count;
    const avgTicket = appointmentStats.appointments ? appointmentStats.revenue / appointmentStats.appointments : 0;
    const conversion = conversationsCount
      ? Math.min(100, (Math.min(appointmentStats.appointments, conversationsCount) / conversationsCount) * 100)
      : 0;
    if (Array.isArray(page.kpis)) {
      if (page.kpis[0]) page.kpis[0].value = formatMoney(appointmentStats.revenue);
      if (page.kpis[1]) page.kpis[1].value = String(appointmentStats.appointments);
      if (page.kpis[2]) page.kpis[2].value = `${conversion.toFixed(1)}%`;
      if (page.kpis[3]) page.kpis[3].value = formatMoney(avgTicket);
      if (page.kpis[1]) page.kpis[1].trend = `${clientsCount} active clients`;
      if (page.kpis[2]) page.kpis[2].trend = `${conversationsCount} active inbox threads`;
    }
    page.stylists = db.prepare(`
      SELECT s.name, s.role, s.avatar,
             COALESCE(SUM(a.price_value), 0) AS revenue,
             COUNT(a.id) AS appointments
      FROM stylists s
      LEFT JOIN appointments a ON a.stylist_id = s.id AND a.checked_out = 0
      GROUP BY s.id
      ORDER BY revenue DESC, appointments DESC, s.sort_order ASC
      LIMIT 3
    `).all().map((row) => ({
      name: row.name,
      role: row.role,
      revenue: formatMoney(row.revenue),
      appointments: `${row.appointments} appts`,
      avatar: row.avatar
    }));
    page.activity = getActivityEntries({ q: search, limit });
    page.activitySummary = {
      total: db.prepare(`SELECT COUNT(*) AS count FROM activity_events`).get().count,
      shown: page.activity.length
    };
    return withLiveQuery(page, { q: search, limit: String(limit) });
  }

  function getClientPreferences(clientId) {
    return db.prepare(`
      SELECT value FROM client_preferences WHERE client_id = ? ORDER BY sort_order ASC
    `).all(clientId).map((row) => row.value);
  }

  function getClientHistory(clientId) {
    return db.prepare(`
      SELECT service, date_label, stylist, amount
      FROM client_history WHERE client_id = ?
      ORDER BY sort_order ASC
    `).all(clientId).map((row) => ({
      service: row.service,
      date: row.date_label,
      stylist: row.stylist,
      amount: row.amount
    }));
  }

  function getClientsPage(options = {}) {
    const page = getBasePage(LIVE_SCREEN_FILES.clients);
    const search = String(options.q || "").trim();
    const status = normalizeQueryValue(options.status) || "all";
    const clientId = String(options.clientId || "").trim();
    page.clients = db.prepare(`
      SELECT id, name, status, status_tone, last_visit, phone, email, avatar, ltv,
             visits_ytd, avg_ticket, formula_base, formula_highlights
      FROM clients
      ORDER BY sort_order ASC, updated_at DESC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      statusTone: row.status_tone,
      lastVisit: row.last_visit,
      phone: row.phone,
      email: row.email,
      avatar: row.avatar,
      ltv: row.ltv,
      visitsYtd: row.visits_ytd,
      avgTicket: row.avg_ticket,
      preferences: getClientPreferences(row.id),
      formulaBase: row.formula_base,
      formulaHighlights: row.formula_highlights,
      history: getClientHistory(row.id)
    })).filter((client) => (
      (status === "all" || normalizeQueryValue(client.status) === status || normalizeQueryValue(client.statusTone) === status) &&
      matchesQuery(search, [client.name, client.email, client.phone, client.status, client.ltv, client.avgTicket].concat(client.preferences || []))
    ));
    page.subtitle = `Manage your ${page.clients.length.toLocaleString("en-US")} active clients.`;
    page.selectedClientId = selectByRequestedId(page.clients, clientId);
    return withLiveQuery(page, { q: search, status, clientId });
  }

  function getConversationHistory(conversationId) {
    return db.prepare(`
      SELECT service, date_label, notes
      FROM conversation_history
      WHERE conversation_id = ?
      ORDER BY sort_order ASC
    `).all(conversationId).map((row) => ({
      service: row.service,
      date: row.date_label,
      notes: row.notes
    }));
  }

  function getConversationMessages(conversationId) {
    return db.prepare(`
      SELECT type, text_value, meta
      FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY sort_order ASC
    `).all(conversationId).map((row) => ({
      type: row.type,
      text: row.text_value,
      meta: row.meta
    }));
  }

  function getConversationSuggestions(conversationId) {
    return db.prepare(`
      SELECT text_value FROM conversation_suggestions
      WHERE conversation_id = ?
      ORDER BY sort_order ASC
    `).all(conversationId).map((row) => row.text_value);
  }

  function getActiveAppointmentForClient(clientId) {
    if (!clientId) return null;
    return db.prepare(`
      SELECT a.*, s.name AS stylist_name
      FROM appointments a
      JOIN stylists s ON s.id = a.stylist_id
      WHERE a.client_id = ? AND a.checked_out = 0
      ORDER BY a.active DESC, a.updated_at DESC, a.sort_order ASC
      LIMIT 1
    `).get(clientId);
  }

  function getInboxPage(options = {}) {
    const page = getBasePage(LIVE_SCREEN_FILES.inbox);
    const search = String(options.q || "").trim();
    const channel = normalizeQueryValue(options.channel) || "all";
    const clientId = String(options.clientId || "").trim();
    const conversationId = String(options.conversationId || "").trim();
    page.conversations = db.prepare(`
      SELECT id, client_id, name, channel, channel_tone, time_label, preview, status, avatar, avatar_text, ltv, visits,
             visit_cadence, today_service, today_time, today_amount, today_stylist,
             contact_phone, contact_email, contact_preference
      FROM conversations
      ORDER BY sort_order ASC, updated_at DESC
    `).all().map((row) => {
      const client = row.client_id ? getClientRecordById(row.client_id) : null;
      const activeAppointment = row.client_id ? getActiveAppointmentForClient(row.client_id) : null;
      return {
        id: row.id,
        clientId: row.client_id || "",
        name: client ? client.name : row.name,
        channel: row.channel,
        channelTone: row.channel_tone,
        time: row.time_label,
        preview: row.preview,
        status: row.status,
        avatar: client ? client.avatar : row.avatar,
        avatarText: row.avatar_text,
        ltv: client ? client.ltv : row.ltv,
        visits: client ? client.visits_ytd : row.visits,
        visitCadence: row.visit_cadence,
        todayVisit: {
          service: activeAppointment ? activeAppointment.service_name : row.today_service,
          time: activeAppointment ? formatTimeRange(activeAppointment.start_minutes, activeAppointment.end_minutes) : row.today_time,
          amount: activeAppointment ? activeAppointment.price_label : row.today_amount,
          stylist: activeAppointment ? activeAppointment.stylist_name : row.today_stylist
        },
        contact: {
          phone: client ? client.phone : row.contact_phone,
          email: client ? client.email : row.contact_email,
          preference: row.contact_preference
        },
        history: row.client_id ? getClientHistory(row.client_id).map((item) => ({
          service: item.service,
          date: item.date,
          notes: `with ${item.stylist} • ${item.amount}`
        })) : getConversationHistory(row.id),
        messages: getConversationMessages(row.id),
        suggestions: getConversationSuggestions(row.id)
      };
    }).filter((conversation) => (
      (channel === "all" || normalizeQueryValue(conversation.channel) === channel || normalizeQueryValue(conversation.channelTone) === channel) &&
      matchesQuery(search, [
        conversation.name,
        conversation.preview,
        conversation.status,
        conversation.channel,
        conversation.contact.phone,
        conversation.contact.email,
        conversation.todayVisit.service,
        conversation.todayVisit.stylist
      ])
    ));
    page.summaryBadge = `${page.conversations.length} Active`;
    page.selectedConversationId = selectByRequestedId(
      page.conversations,
      conversationId,
      (conversation) => conversation.clientId === clientId,
      clientId ? false : true
    );
    return withLiveQuery(page, { q: search, channel, clientId, conversationId });
  }

  function getStaticScreen(screenFile) {
    return getBasePage(screenFile);
  }

  function getPage(screenSlug, options = {}) {
    const pageFile = `${screenSlug}.html`;
    if (pageFile === "salon-performance-luminous-core.html") return getPerformancePage(options);
    if (pageFile === "services-pricing-luminous-core.html") return getServicesPage();
    if (pageFile === "stylist-schedule-luminous-core.html") return getSchedulePage(options);
    if (pageFile === LIVE_SCREEN_FILES.inventory) return getInventoryPage(options);
    if (pageFile === LIVE_SCREEN_FILES.automations) return getAutomationsPage(options);
    if (pageFile === LIVE_SCREEN_FILES.clients) return getClientsPage(options);
    if (pageFile === LIVE_SCREEN_FILES.inbox) return getInboxPage(options);
    if (!demo.pages[pageFile]) return null;
    return getStaticScreen(pageFile);
  }

  function getSalon() {
    const salon = clone(demo.salon || {});
    salon.lastUpdated = getLastUpdated();
    return salon;
  }

  function getScreen(screenSlug, options = {}) {
    const page = getPage(screenSlug, options);
    if (!page) return null;
    return {
      lastUpdated: getLastUpdated(),
      salon: getSalon(),
      screen: screenSlug,
      page
    };
  }

  function listScreens() {
    return Object.keys(demo.pages).map((file) => ({
      id: file.replace(/\.html$/, ""),
      file,
      title: demo.pages[file].title || demo.pages[file].searchPlaceholder || file
    }));
  }

  function getPerformanceReport(options = {}) {
    const appointmentStats = db.prepare(`
      SELECT COUNT(*) AS appointments,
             COALESCE(SUM(price_value), 0) AS revenue
      FROM appointments
    `).get();
    const clientsCount = db.prepare(`SELECT COUNT(*) AS count FROM clients`).get().count;
    const conversationsCount = db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get().count;
    const avgTicket = appointmentStats.appointments ? appointmentStats.revenue / appointmentStats.appointments : 0;
    const activity = getActivityEntries({ q: options.q || "", limit: Math.max(3, Number(options.limit) || 10) });
    return {
      generatedAt: getLastUpdated(),
      metrics: {
        revenue: formatMoney(appointmentStats.revenue),
        appointments: appointmentStats.appointments,
        activeClients: clientsCount,
        activeInboxThreads: conversationsCount,
        avgTicket: formatMoney(avgTicket)
      },
      topStylists: db.prepare(`
        SELECT s.name, COALESCE(SUM(a.price_value), 0) AS revenue, COUNT(a.id) AS appointments
        FROM stylists s
        LEFT JOIN appointments a ON a.stylist_id = s.id AND a.checked_out = 0
        GROUP BY s.id
        ORDER BY revenue DESC, appointments DESC, s.sort_order ASC
        LIMIT 5
      `).all().map((row) => ({
        name: row.name,
        revenue: formatMoney(row.revenue),
        appointments: row.appointments
      })),
      recentActivity: activity,
      summaryText: [
        `Revenue: ${formatMoney(appointmentStats.revenue)}`,
        `Appointments: ${appointmentStats.appointments}`,
        `Active clients: ${clientsCount}`,
        `Active inbox threads: ${conversationsCount}`,
        `Average ticket: ${formatMoney(avgTicket)}`,
        "",
        "Recent activity:",
        activity.map((item) => `- ${item.title}: ${item.meta} (${item.time})`).join("\n")
      ].join("\n")
    };
  }

  function updateInventoryItem(sku, updates) {
    const current = db.prepare(`
      SELECT sku, stock_quantity, stock_unit, reorder_quantity FROM inventory_items WHERE sku = ?
    `).get(sku);
    if (!current) return null;

    if (typeof updates.stock === "string" && updates.stock.trim()) {
      const quantity = Number(updates.stock);
      const nextTone =
        quantity <= current.reorder_quantity / 2 ? "low" :
        quantity <= current.reorder_quantity ? "watch" : "ok";
      db.prepare(`
        UPDATE inventory_items
        SET stock_quantity = ?, stock_tone = ?
        WHERE sku = ?
      `).run(quantity, nextTone, sku);
      logActivity({
        title: "Inventory Updated",
        meta: `${sku} adjusted to ${quantity} ${current.stock_unit}`,
        icon: "inventory_2",
        tone: "secondary"
      });
    }
    touch();
    return db.prepare(`
      SELECT sku, name, brand, icon, stock_quantity, stock_unit, reorder_quantity, reorder_unit, cost_label, stock_tone, category
      FROM inventory_items WHERE sku = ?
    `).get(sku);
  }

  function createRestockOrder() {
    const lowItems = db.prepare(`
      SELECT sku, name, reorder_quantity FROM inventory_items WHERE stock_tone = 'low'
    `).all();
    const restock = db.transaction(() => {
      lowItems.forEach((item) => {
        db.prepare(`
          UPDATE inventory_items
          SET stock_quantity = reorder_quantity, stock_tone = 'ok'
          WHERE sku = ?
        `).run(item.sku);
      });
      db.prepare(`
        UPDATE inventory_shipments SET sort_order = sort_order + 1
      `).run();
      db.prepare(`
        INSERT INTO inventory_shipments (id, title, meta, time_label, status, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        createId("shipment", "restock"),
        `Restock Order Created${lowItems.length ? `: ${lowItems.length} low items` : ""}`,
        `PO-${new Date().toISOString().slice(0, 10)} • Generated from control layer`,
        "Just now",
        lowItems.length ? "Ordered" : "No Action",
        new Date().toISOString()
      );
      logActivity({
        title: "Restock Order Created",
        meta: lowItems.length ? `${lowItems.length} inventory items reordered` : "No low-stock items required action",
        icon: "local_shipping",
        tone: "tertiary"
      });
      return lowItems.length;
    });

    const touchedItems = restock();
    touch();
    return touchedItems;
  }

  function toggleWorkflow(name, enabled) {
    const result = db.prepare(`
      UPDATE workflows SET enabled = ? WHERE lower(name) = lower(?)
    `).run(enabled ? 1 : 0, name);
    if (!result.changes) return null;
    logActivity({
      title: enabled ? "Workflow Enabled" : "Workflow Paused",
      meta: name,
      icon: "auto_awesome",
      tone: "secondary"
    });
    touch();
    return db.prepare(`
      SELECT name, enabled FROM workflows WHERE lower(name) = lower(?)
    `).get(name);
  }

  function upsertBuilderWorkflow(input) {
    const builder = {
      trigger: String(input.trigger || "").trim() || "Missed appointment",
      action: String(input.action || "").trim() || "Send reminder",
      message: String(input.message || "").trim() || "We have a new workflow ready."
    };
    db.prepare(`
      INSERT INTO automation_builder (id, trigger_text, action_text, message_text)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        trigger_text = excluded.trigger_text,
        action_text = excluded.action_text,
        message_text = excluded.message_text
    `).run(builder.trigger, builder.action, builder.message);

    const workflowName = `${builder.trigger} Flow`;
    const existing = db.prepare(`
      SELECT name FROM workflows WHERE name = ?
    `).get(workflowName);
    if (existing) {
      db.prepare(`
        UPDATE workflows
        SET subtitle = ?, trigger_text = ?, action_text = ?, enabled = 1
        WHERE name = ?
      `).run(
        `Custom ${builder.action}`,
        builder.trigger,
        `${builder.action} • ${builder.message.slice(0, 40)}${builder.message.length > 40 ? "..." : ""}`,
        workflowName
      );
    } else {
      db.prepare(`UPDATE workflows SET sort_order = sort_order + 1`).run();
      db.prepare(`
        INSERT INTO workflows (
          name, subtitle, trigger_text, action_text, sent, converted, conversion_rate,
          revenue, icon, tone, enabled, sort_order
        ) VALUES (?, ?, ?, ?, '0', '0', '0%', '$0', 'auto_awesome', 'tertiary', 1, 0)
      `).run(
        workflowName,
        `Custom ${builder.action}`,
        builder.trigger,
        `${builder.action} • ${builder.message.slice(0, 40)}${builder.message.length > 40 ? "..." : ""}`
      );
    }

    logActivity({
      title: "Automation Builder Updated",
      meta: `${builder.trigger} -> ${builder.action}`,
      icon: "bolt",
      tone: "secondary"
    });
    touch();
    return getAutomationsPage();
  }

  function updateService(id, updates) {
    const service = db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
    if (!service) return null;
    let categoryId = service.category_id;
    if (typeof updates.category === "string" && updates.category.trim()) {
      const category = db.prepare(`SELECT id FROM service_categories WHERE name = ?`).get(updates.category.trim());
      if (category) categoryId = category.id;
    }
    db.prepare(`
      UPDATE services
      SET category_id = ?, name = ?, duration_minutes = ?, processing_time_minutes = ?, price_label = ?, price_value = ?,
          commission_rate = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(
      categoryId,
      typeof updates.name === "string" && updates.name.trim() ? updates.name.trim() : service.name,
      Number(updates.duration || service.duration_minutes),
      Number(updates.processingTime || service.processing_time_minutes),
      `$${Number(updates.price || service.price_value).toFixed(2)}`,
      Number(updates.price || service.price_value),
      Number(updates.commission || service.commission_rate),
      typeof updates.description === "string" ? updates.description.trim() : service.description,
      new Date().toISOString(),
      id
    );
    logActivity({
      title: "Service Updated",
      meta: typeof updates.name === "string" && updates.name.trim() ? updates.name.trim() : service.name,
      icon: "spa",
      tone: "secondary"
    });
    touch();
    return id;
  }

  function syncAppointmentFromEntities(appointmentId) {
    const appointment = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId);
    if (!appointment) return null;
    const client = appointment.client_id ? getClientRecordById(appointment.client_id) : null;
    const service = appointment.service_id ? getServiceById(appointment.service_id) : null;
    db.prepare(`
      UPDATE appointments
      SET client_name = ?, avatar = ?, service_name = ?, price_label = ?, price_value = ?,
          since_label = ?, history_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      client ? client.name : appointment.client_name,
      client ? client.avatar : appointment.avatar,
      service ? service.name : appointment.service_name,
      service ? service.price_label : appointment.price_label,
      service ? service.price_value : appointment.price_value,
      client ? buildSinceLabel(client) : appointment.since_label,
      client ? JSON.stringify(buildClientHistoryPreview(client.id)) : appointment.history_json,
      new Date().toISOString(),
      appointmentId
    );
    return appointmentId;
  }

  function createAppointment(payload) {
    const stylist = db.prepare(`SELECT * FROM stylists WHERE name = ?`).get(payload.stylist) || getStylistRows()[0];
    if (!stylist) return null;
    const client = resolveClientForAppointment({
      clientId: payload.clientId,
      name: payload.client,
      email: payload.email,
      phone: payload.phone
    });
    const service = (payload.serviceId && getServiceById(payload.serviceId)) || getServiceByName(payload.service) || null;
    const date = typeof payload.date === "string" ? payload.date : "11:00-12:00";
    const match = date.match(/^(.+?)\s*-\s*(.+)$/);
    const startMinutes = match ? parseClockLabel(match[1], 11 * 60) : 11 * 60;
    const endMinutes = match ? parseClockLabel(match[2], 12 * 60) : 12 * 60;
    db.prepare(`UPDATE appointments SET active = 0`).run();
    const id = createId("appointment", `${payload.client}-${payload.service}`);
    db.prepare(`UPDATE appointments SET sort_order = sort_order + 1`).run();
    db.prepare(`
      INSERT INTO appointments (
        id, stylist_id, client_id, service_id, service_name, client_name, avatar, tone, start_minutes, end_minutes, badge,
        price_label, price_value, active, tags_json, notes, quiet_preference, history_json, since_label,
        checked_out, sort_order, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?, ?, '', ?, ?, 1, '[]', ?, ?, '[]', ?, 0, 0, ?)
    `).run(
      id,
      stylist.id,
      client ? client.id : "",
      service ? service.id : "",
      service ? service.name : payload.service || "Custom Service",
      client ? client.name : payload.client || "Walk-in Client",
      client ? client.avatar : "",
      startMinutes,
      endMinutes,
      service ? service.price_label : formatMoney(Number(payload.amount || 0)),
      service ? service.price_value : Number(payload.amount || 0),
      payload.notes || "New booking created from schedule panel.",
      payload.quietPreference || "No special preference recorded.",
      client ? buildSinceLabel(client) : payload.since || "New client",
      new Date().toISOString()
    );
    syncAppointmentFromEntities(id);
    logActivity({
      title: `New Booking: ${(service && service.name) || payload.service || "Custom Service"}`,
      meta: `Client: ${(client && client.name) || payload.client || "Walk-in Client"} • with ${stylist.name}`,
      icon: "bookmark",
      tone: "secondary"
    });
    touch();
    return id;
  }

  function updateAppointment(id, updates) {
    const appointment = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
    if (!appointment) return null;
    db.prepare(`
      UPDATE appointments
      SET notes = ?, quiet_preference = ?, updated_at = ?
      WHERE id = ?
    `).run(
      typeof updates.notes === "string" && updates.notes.trim() ? updates.notes.trim() : appointment.notes,
      typeof updates.quietPreference === "string" && updates.quietPreference.trim() ? updates.quietPreference.trim() : appointment.quiet_preference,
      new Date().toISOString(),
      id
    );
    logActivity({
      title: "Appointment Notes Updated",
      meta: appointment.client_name,
      icon: "edit_note",
      tone: "tertiary"
    });
    touch();
    return syncAppointmentFromEntities(id);
  }

  function checkoutAppointment(id) {
    const appointment = db.prepare(`
      SELECT a.*, s.name AS stylist_name
      FROM appointments a
      JOIN stylists s ON s.id = a.stylist_id
      WHERE a.id = ?
    `).get(id);
    if (!appointment) return null;
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE appointments
        SET checked_out = 1, active = 0, updated_at = ?
        WHERE id = ?
      `).run(now, id);
      if (appointment.client_id) {
        const client = getClientRecordById(appointment.client_id);
        if (client) {
          const nextVisits = Number(client.visits_ytd || 0) + 1;
          const nextLtv = parseMoney(client.ltv) + Number(appointment.price_value || 0);
          db.prepare(`
            UPDATE clients
            SET last_visit = ?, visits_ytd = ?, ltv = ?, avg_ticket = ?, status = ?, status_tone = ?, updated_at = ?
            WHERE id = ?
          `).run(
            formatDisplayDate(now),
            String(nextVisits),
            formatMoney(nextLtv),
            formatMoney(nextVisits ? nextLtv / nextVisits : Number(appointment.price_value || 0)),
            client.status_tone === "new" ? "REGULAR" : client.status,
            client.status_tone === "new" ? "regular" : client.status_tone,
            now,
            client.id
          );
          db.prepare(`UPDATE client_history SET sort_order = sort_order + 1 WHERE client_id = ?`).run(client.id);
          db.prepare(`
            INSERT INTO client_history (id, client_id, service, date_label, stylist, amount, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, 0)
          `).run(
            createId("client-history", `${client.id}-${appointment.service_name}`),
            client.id,
            appointment.service_name,
            formatDisplayDate(now),
            appointment.stylist_name,
            appointment.price_label
          );
        }
      }
    })();
    logActivity({
      title: "Checkout Completed",
      meta: `${appointment.client_name} • ${appointment.service_name}`,
      icon: "check_circle",
      tone: "neutral"
    });
    touch(now);
    return id;
  }

  function shiftOrders(table) {
    db.prepare(`UPDATE ${table} SET sort_order = sort_order + 1`).run();
  }

  function createClient(input) {
    const statusInfo = normalizeClientStatus(input.status);
    const now = new Date().toISOString();
    const id = input.id || createId("client", input.name || "client");
    const preferences = Array.isArray(input.preferences)
      ? input.preferences
      : String(input.preferences || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

    shiftOrders("clients");
    db.prepare(`
      INSERT INTO clients (
        id, name, status, status_tone, last_visit, phone, email, avatar, ltv, visits_ytd,
        avg_ticket, formula_base, formula_highlights, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '$0', '0', '$0', ?, ?, 0, ?, ?)
    `).run(
      id,
      String(input.name || "New Client").trim(),
      statusInfo.status,
      statusInfo.statusTone,
      input.lastVisit || "First visit scheduled",
      String(input.phone || "(555) 000-0000").trim(),
      String(input.email || "pending@client.local").trim(),
      String(input.avatar || demo.pages[LIVE_SCREEN_FILES.clients].clients[0].avatar || ""),
      input.formulaBase || "Pending consultation",
      input.formulaHighlights || "Pending consultation",
      now,
      now
    );
    preferences.forEach((preference, index) => {
      db.prepare(`
        INSERT INTO client_preferences (client_id, value, sort_order) VALUES (?, ?, ?)
      `).run(id, preference, index);
    });
    logActivity({
      title: "New Client Added",
      meta: `${input.name} entered the directory`,
      icon: "group",
      tone: "secondary"
    });
    touch(now);
    return id;
  }

  function updateClient(id, updates) {
    const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(id);
    if (!client) return null;
    const statusInfo = updates.status ? normalizeClientStatus(updates.status) : null;
    db.prepare(`
      UPDATE clients
      SET name = ?, status = ?, status_tone = ?, last_visit = ?, phone = ?, email = ?, formula_base = ?,
          formula_highlights = ?, updated_at = ?
      WHERE id = ?
    `).run(
      typeof updates.name === "string" && updates.name.trim() ? updates.name.trim() : client.name,
      statusInfo ? statusInfo.status : client.status,
      statusInfo ? statusInfo.statusTone : client.status_tone,
      typeof updates.lastVisit === "string" && updates.lastVisit.trim() ? updates.lastVisit.trim() : client.last_visit,
      typeof updates.phone === "string" && updates.phone.trim() ? updates.phone.trim() : client.phone,
      typeof updates.email === "string" && updates.email.trim() ? updates.email.trim() : client.email,
      typeof updates.formulaBase === "string" ? updates.formulaBase.trim() || client.formula_base : client.formula_base,
      typeof updates.formulaHighlights === "string" ? updates.formulaHighlights.trim() || client.formula_highlights : client.formula_highlights,
      new Date().toISOString(),
      id
    );
    if (typeof updates.preferences === "string" || Array.isArray(updates.preferences)) {
      const preferences = Array.isArray(updates.preferences)
        ? updates.preferences
        : String(updates.preferences || "").split(",").map((value) => value.trim()).filter(Boolean);
      db.prepare(`DELETE FROM client_preferences WHERE client_id = ?`).run(id);
      preferences.forEach((preference, index) => {
        db.prepare(`
          INSERT INTO client_preferences (client_id, value, sort_order) VALUES (?, ?, ?)
        `).run(id, preference, index);
      });
    }
    logActivity({
      title: "Client Updated",
      meta: client.name,
      icon: "person",
      tone: "secondary"
    });
    touch();
    return id;
  }

  function deleteClient(id) {
    const result = db.transaction(() => {
      const client = db.prepare(`SELECT id, name FROM clients WHERE id = ?`).get(id);
      if (!client) return null;
      db.prepare(`DELETE FROM client_preferences WHERE client_id = ?`).run(id);
      db.prepare(`DELETE FROM client_history WHERE client_id = ?`).run(id);
      db.prepare(`DELETE FROM clients WHERE id = ?`).run(id);
      return client;
    })();
    if (result) touch();
    return result;
  }

  function createClientBooking(id, payload) {
    const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(id);
    if (!client) return null;

    const amountValue = parseMoney(payload.amount, parseMoney(client.avg_ticket));
    const dateLabel = formatDisplayDate(payload.date);
    db.prepare(`
      UPDATE clients
      SET last_visit = ?, updated_at = ?
      WHERE id = ?
    `).run(
      `Booked: ${dateLabel}`,
      new Date().toISOString(),
      id
    );
    createAppointment({
      clientId: id,
      client: client.name,
      email: client.email,
      phone: client.phone,
      service: payload.service || "Custom Booking",
      stylist: payload.stylist || "Front Desk",
      amount: String(amountValue),
      date: payload.slot || "11:00-12:00",
      notes: payload.notes || "Scheduled from client profile.",
      quietPreference: getClientPreferences(id).join(", ") || "No special preference recorded."
    });
    logActivity({
      title: `New Booking: ${payload.service || "Custom Booking"}`,
      meta: `Client: ${client.name} • with ${payload.stylist || "Front Desk"}`,
      icon: "bookmark",
      tone: "secondary"
    });
    touch();
    return id;
  }

  function createConversation(input) {
    const now = new Date().toISOString();
    const id = input.id || createId("conv", input.name || "conversation");
    const client = resolveClientForAppointment({
      clientId: input.clientId,
      name: input.name,
      email: input.contact && input.contact.email,
      phone: input.contact && input.contact.phone
    }, { allowPhoneMatch: false });
    shiftOrders("conversations");
    const channel = titleCaseWords(input.channel || "WhatsApp");
    const channelTone = String(input.channelTone || input.channel || "whatsapp").toLowerCase();
    db.prepare(`
      INSERT INTO conversations (
        id, client_id, name, channel, channel_tone, time_label, preview, status, avatar, avatar_text, ltv,
        visits, visit_cadence, today_service, today_time, today_amount, today_stylist,
        contact_phone, contact_email, contact_preference, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Now', ?, ?, ?, ?, '$0', '0', 'First visit pending', 'Consultation', 'Pending', '$0',
        'Front Desk', ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      client ? client.id : "",
      String(input.name || "New Conversation").trim(),
      channel,
      channelTone,
      input.preview || "Conversation created.",
      input.status || `Active on ${channel}`,
      String((client && client.avatar) || input.avatar || ""),
      input.avatarText || String(input.name || "NC").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
      input.contact && input.contact.phone ? input.contact.phone : (client ? client.phone : "(555) 000-0000"),
      input.contact && input.contact.email ? input.contact.email : (client ? client.email : "pending@client.local"),
      input.contact && input.contact.preference ? input.contact.preference : "Text updates",
      now,
      now
    );

    (input.messages || []).forEach((message, index) => {
      db.prepare(`
        INSERT INTO conversation_messages (id, conversation_id, type, text_value, meta, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        createId("message", `${id}-${index}`),
        id,
        message.type || "outgoing",
        message.text || "",
        message.meta || "Just now • Sent",
        index,
        now
      );
    });
    const suggestions = Array.isArray(input.suggestions) && input.suggestions.length
      ? input.suggestions
      : ["Happy to help.", "Let me confirm that for you.", "I'll update you in a moment."];
    suggestions.forEach((suggestion, index) => {
      db.prepare(`
        INSERT INTO conversation_suggestions (id, conversation_id, text_value, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(createId("suggestion", `${id}-${index}`), id, suggestion, index);
    });
    logActivity({
      title: "Conversation Started",
      meta: `${input.name} on ${channel}`,
      icon: "chat_bubble",
      tone: "secondary"
    });
    touch(now);
    return id;
  }

  function updateConversation(id, updates) {
    const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
    if (!conversation) return null;
    db.prepare(`
      UPDATE conversations
      SET status = ?, preview = ?, contact_preference = ?, updated_at = ?
      WHERE id = ?
    `).run(
      typeof updates.status === "string" && updates.status.trim() ? updates.status.trim() : conversation.status,
      typeof updates.preview === "string" && updates.preview.trim() ? updates.preview.trim() : conversation.preview,
      typeof updates.preference === "string" && updates.preference.trim() ? updates.preference.trim() : conversation.contact_preference,
      new Date().toISOString(),
      id
    );
    if (typeof updates.note === "string" && updates.note.trim()) {
      const firstHistory = db.prepare(`
        SELECT id FROM conversation_history WHERE conversation_id = ? ORDER BY sort_order ASC LIMIT 1
      `).get(id);
      if (firstHistory) {
        db.prepare(`UPDATE conversation_history SET notes = ? WHERE id = ?`).run(updates.note.trim(), firstHistory.id);
      } else {
        db.prepare(`
          INSERT INTO conversation_history (id, conversation_id, service, date_label, notes, sort_order)
          VALUES (?, ?, 'Internal note', ?, ?, 0)
        `).run(createId("conversation-history", id), id, formatShortDate(new Date()), updates.note.trim());
      }
    }
    if (conversation.client_id) {
      const client = getClientRecordById(conversation.client_id);
      if (client && typeof updates.preference === "string" && updates.preference.trim()) {
        const nextPreferences = [updates.preference.trim()].concat(
          getClientPreferences(client.id).filter((entry) => entry !== updates.preference.trim())
        );
        db.prepare(`DELETE FROM client_preferences WHERE client_id = ?`).run(client.id);
        nextPreferences.slice(0, 5).forEach((preference, index) => {
          db.prepare(`
            INSERT INTO client_preferences (client_id, value, sort_order) VALUES (?, ?, ?)
          `).run(client.id, preference, index);
        });
      }
    }
    if (Array.isArray(updates.suggestions) && updates.suggestions.length) {
      db.prepare(`DELETE FROM conversation_suggestions WHERE conversation_id = ?`).run(id);
      updates.suggestions.forEach((suggestion, index) => {
        db.prepare(`
          INSERT INTO conversation_suggestions (id, conversation_id, text_value, sort_order)
          VALUES (?, ?, ?, ?)
        `).run(createId("suggestion", `${id}-${index}`), id, String(suggestion).trim(), index);
      });
    }
    touch();
    return id;
  }

  function deleteConversation(id) {
    const result = db.transaction(() => {
      const conversation = db.prepare(`SELECT id, name FROM conversations WHERE id = ?`).get(id);
      if (!conversation) return null;
      db.prepare(`DELETE FROM conversation_history WHERE conversation_id = ?`).run(id);
      db.prepare(`DELETE FROM conversation_messages WHERE conversation_id = ?`).run(id);
      db.prepare(`DELETE FROM conversation_suggestions WHERE conversation_id = ?`).run(id);
      db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
      return conversation;
    })();
    if (result) touch();
    return result;
  }

  function createConversationMessage(id, payload) {
    const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
    if (!conversation) return null;
    const text = String(payload.text || "").trim();
    if (!text) return { error: "Message text is required." };
    const type = payload.type === "incoming" ? "incoming" : payload.type === "system" ? "system" : "outgoing";
    const meta = type === "outgoing" ? "Just now • Sent" : "Just now";
    const currentMax = db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
      FROM conversation_messages
      WHERE conversation_id = ?
    `).get(id).max_sort_order;
    db.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, type, text_value, meta, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createId("message", id), id, type, text, meta, currentMax + 1, new Date().toISOString());
    db.prepare(`
      UPDATE conversations
      SET preview = ?, time_label = 'Now', status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      text,
      type === "outgoing" ? `Awaiting reply on ${conversation.channel}` : conversation.status,
      new Date().toISOString(),
      id
    );
    logActivity({
      title: type === "outgoing" ? "Reply Sent" : "Inbound Message Logged",
      meta: `${conversation.name} • ${conversation.channel}`,
      icon: "send",
      tone: "secondary"
    });
    touch();
    return id;
  }

  function createConversationBooking(id, payload) {
    const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
    if (!conversation) return null;
    const client = conversation.client_id
      ? getClientRecordById(conversation.client_id)
      : resolveClientForAppointment({
          name: conversation.name,
          email: conversation.contact_email
        });
    if (!client) return null;
    const appointmentId = createAppointment({
      clientId: client.id,
      client: client.name,
      email: client.email,
      phone: client.phone,
      service: payload.service || conversation.today_service || "Consultation",
      stylist: payload.stylist || conversation.today_stylist || "Front Desk",
      date: payload.slot || "11:00-12:00",
      amount: payload.amount || String(parseMoney(conversation.today_amount || 0)),
      notes: payload.notes || "Booked from unified inbox.",
      quietPreference: conversation.contact_preference || "No special preference recorded."
    });
    if (!appointmentId) return null;
    const bookedAppointment = db.prepare(`
      SELECT a.service_name, a.price_label, a.start_minutes, a.end_minutes, s.name AS stylist_name
      FROM appointments a
      JOIN stylists s ON s.id = a.stylist_id
      WHERE a.id = ?
    `).get(appointmentId);
    const serviceName = bookedAppointment ? bookedAppointment.service_name : payload.service || conversation.today_service || "Consultation";
    const stylistName = bookedAppointment ? bookedAppointment.stylist_name : payload.stylist || conversation.today_stylist || "Front Desk";
    const timeLabel = bookedAppointment ? formatTimeRange(bookedAppointment.start_minutes, bookedAppointment.end_minutes) : payload.slot || "11:00-12:00";
    const amountLabel = bookedAppointment ? bookedAppointment.price_label : typeof payload.amount === "string" ? `$${String(payload.amount).replace(/^\$/, "")}` : conversation.today_amount;
    db.prepare(`
      UPDATE conversations
      SET client_id = ?, status = ?, today_service = ?, today_time = ?, today_amount = ?, today_stylist = ?, updated_at = ?
      WHERE id = ?
    `).run(
      client.id,
      "Booked from inbox",
      serviceName,
      timeLabel,
      amountLabel,
      stylistName,
      new Date().toISOString(),
      id
    );
    const currentMax = db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
      FROM conversation_messages
      WHERE conversation_id = ?
    `).get(id).max_sort_order;
    db.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, type, text_value, meta, sort_order, created_at)
      VALUES (?, ?, 'system', ?, 'Just now', ?, ?)
    `).run(
      createId("message", `${id}-booking`),
      id,
      `Appointment booked: ${serviceName} with ${stylistName}.`,
      currentMax + 1,
      new Date().toISOString()
    );
    touch();
    return {
      appointmentId,
      clientId: client.id,
      service: serviceName,
      slot: timeLabel,
      amount: amountLabel,
      stylist: stylistName
    };
  }

  runSchema();
  runMigrations();
  ensureSeeded();
  repairMissingEntityLinks();

  return {
    dbFile: DB_FILE,
    getLastUpdated,
    getSalon,
    getScreen,
    listScreens,
    getPerformanceReport,
    reset: seedFromDemo,
    health() {
      return {
        ok: true,
        service: "platform-api",
        storage: "sqlite",
        dbFile: DB_FILE,
        lastUpdated: getLastUpdated()
      };
    },
    getInventoryPage,
    getAutomationsPage,
    getServicesPage,
    getSchedulePage,
    getPerformancePage,
    getClientsPage,
    getInboxPage,
    updateInventoryItem,
    createRestockOrder,
    toggleWorkflow,
    upsertBuilderWorkflow,
    updateService,
    createAppointment,
    updateAppointment,
    checkoutAppointment,
    createClient,
    updateClient,
    deleteClient,
    createClientBooking,
    createConversation,
    updateConversation,
    deleteConversation,
    createConversationMessage,
    createConversationBooking
  };
}

module.exports = {
  createPlatformStore,
  DB_FILE
};
