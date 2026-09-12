const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  extractMessageContent,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  Browsers,
} = require("baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PORT || 3001);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY;
const SENT_FILE = path.join(__dirname, "whatsapp-sent.json");
const AUTH_DIR = path.join(__dirname, "auth");
const ANNOUNCEMENT_GROUP_NAME = process.env.WHATSAPP_ANNOUNCEMENT_GROUP_NAME || "İTÜAS";
let announcementGroupJid = process.env.WHATSAPP_ANNOUNCEMENT_GROUP_ID || null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️ SUPABASE_URL veya anahtar eksik. Görev durumu WhatsApp cevabından güncellenemeyebilir.");
}

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

let sock = null;
let botReady = false;
let botStarting = false;
let botGeneration = 0;
let reconnectTimer = null;
let reminderRunning = false;
let watcherRunning = false;
const sending = new Set();
const handledMessages = new Set();

function loadSent() {
  try { return JSON.parse(fs.readFileSync(SENT_FILE, "utf8")); }
  catch { return {}; }
}

function saveSent(data) {
  fs.writeFileSync(SENT_FILE, JSON.stringify(data, null, 2), "utf8");
}

const sent = loadSent();
sent.pendingApprovals = sent.pendingApprovals || {};
sent.decisions = sent.decisions || {};
sent.outbox = Array.isArray(sent.outbox) ? sent.outbox : [];

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = "90" + digits.slice(1);
  if (digits.length === 10 && digits.startsWith("5")) digits = "90" + digits;
  if (digits.startsWith("90") && digits.length === 12) return digits;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

function jidFromPhone(phone) {
  const digits = normalizePhone(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function phoneFromJid(jid) {
  if (!jid || String(jid).includes("@g.us") || String(jid).includes("@lid")) return null;
  return normalizePhone(String(jid).split("@")[0]);
}

async function sendWhatsApp(phone, message) {
  if (!botReady || !sock) throw new Error("WhatsApp bot henüz bağlı değil.");
  const fallbackJid = jidFromPhone(phone);
  if (!fallbackJid) throw new Error("Geçersiz telefon numarası: " + String(phone || ""));
  let jid = fallbackJid;
  try {
    const digits = normalizePhone(phone);
    const checked = await sock.onWhatsApp(digits, fallbackJid);
    const found = (checked || []).find(item => item?.exists && item?.jid) || (checked || [])[0];
    if (found?.exists === false) throw new Error("Bu numara WhatsApp'ta kayıtlı değil.");
    if (found?.jid) jid = found.jid;
  } catch (err) {
    if (/kayıtlı değil/.test(err.message || "")) throw err;
  }
  const result = await sock.sendMessage(jid, { text: message });
  return { ok: true, jid, result };
}



async function findAnnouncementGroup() {
  if (!sock) return null;
  if (announcementGroupJid) return announcementGroupJid;
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups || {});
    const wanted = String(ANNOUNCEMENT_GROUP_NAME || "").trim().toLocaleLowerCase("tr-TR");
    const exact = list.find(g => String(g.subject || "").trim().toLocaleLowerCase("tr-TR") === wanted);
    const partial = list.find(g => String(g.subject || "").toLocaleLowerCase("tr-TR").includes(wanted));
    const found = exact || partial;
    if (found?.id) {
      announcementGroupJid = found.id;
      console.log(`📢 Duyuru grubu bulundu: ${found.subject} (${found.id})`);
      return announcementGroupJid;
    }
    console.warn(`⚠️ Duyuru grubu bulunamadı: ${ANNOUNCEMENT_GROUP_NAME}`);
    console.log("📋 WhatsApp grupları:");
    list.forEach(g => console.log(` - ${g.subject} | ${g.id}`));
  } catch (err) {
    console.error("Grup listesi alınamadı:", err.message || err);
  }
  return null;
}

function announcementMessage(announcement) {
  return [
    `📢 *İTÜAS OTONOM TEKNE TAKIMI – DUYURU*`,
    "",
    `📌 *${announcement.title || "Duyuru"}*`,
    announcement.body ? `\n${announcement.body}` : null,
    "",
    `⚡ Öncelik: *${announcement.priority || "Normal"}*`,
    announcement.author ? `👤 ${announcement.author}` : null,
  ].filter(Boolean).join("\n");
}

async function sendAnnouncementToGroup(announcement) {
  const key = `announcement:${announcement.id}`;
  if (!announcement?.id || sent[key]) return false;
  const groupJid = await findAnnouncementGroup();
  if (!groupJid || !botReady || !sock) return false;
  await sock.sendMessage(groupJid, { text: announcementMessage(announcement) });
  sent[key] = new Date().toISOString();
  saveSent(sent);
  console.log(`📢 Duyuru gruba gönderildi: ${announcement.title}`);
  return true;
}

let announcementWatcherRunning = false;
async function watchNewAnnouncements() {
  if (announcementWatcherRunning || !supabase || !botReady) return;
  announcementWatcherRunning = true;
  try {
    const { data: announcements, error } = await supabase
      .from("announcements")
      .select("id,title,body,priority,author,created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    for (const announcement of announcements || []) {
      if (sent[`announcement:${announcement.id}`]) continue;
      const created = new Date(announcement.created_at || 0).getTime();
      if (!Number.isFinite(created) || created < Date.now() - 5 * 60 * 1000) continue;
      try { await sendAnnouncementToGroup(announcement); }
      catch (err) { console.error(`Duyuru gruba gönderilemedi (${announcement.title}):`, err.message || err); }
    }
  } catch (err) {
    console.error("Duyuru kontrolü başarısız:", err.message || err);
  } finally {
    announcementWatcherRunning = false;
  }
}

function taskAssignedMessage({ memberName, taskTitle, description, due, priority }) {
  return [
    `🤖 *İTÜAS Otonom Tekne Takımı – Yeni Görev Onayı*`,
    `Merhaba ${memberName || ""}!`,
    "",
    `📌 *Görev:* ${taskTitle}`,
    description ? `📝 *Açıklama:* ${description}` : null,
    `📅 *Son tarih:* ${due || "Belirtilmedi"}`,
    `⚡ *Öncelik:* ${priority || "Orta"}`,
    "",
    `Bu görevi kabul ediyor musun?`,
    `Cevap olarak *KABUL* veya *REDDET* yaz.`,
  ].filter(Boolean).join("\n");
}

function taskReminderMessage(memberName, task) {
  return [
    `⏰ *İTÜAS Otonom Tekne Takımı – Görev Hatırlatması*`,
    `Merhaba ${memberName || ""}!`,
    "",
    `Yarına ait görevin var:`,
    `📌 *${task.title}*`,
    task.description ? `📝 ${task.description}` : null,
    `📅 *Son tarih:* ${task.due_date}`,
    `⚡ *Öncelik:* ${task.priority || "Orta"}`,
    "",
    `Kolay gelsin! 💪`,
  ].filter(Boolean).join("\n");
}

function rememberPending(taskId, { phone, jid, jids, memberName, title }) {
  const id = String(taskId);
  const extra = (jids || []).filter(Boolean);
  sent.pendingApprovals[id] = {
    taskId: id,
    phone: normalizePhone(phone) || phone || "",
    jid: jid || "",
    jids: Array.from(new Set([jid, ...extra].filter(Boolean))),
    memberName: memberName || "",
    title: title || "",
    waiting: true,
    sentAt: new Date().toISOString(),
  };
  saveSent(sent);
}

function markAssignedSent(taskId) {
  sent[`assigned:${taskId}`] = new Date().toISOString();
  saveSent(sent);
}

function wasAssignedSent(taskId) {
  return Boolean(sent[`assigned:${taskId}`]);
}

function enqueueOutbox(job) {
  sent.outbox = sent.outbox || [];
  const taskId = String(job.taskId);
  if (sent.outbox.some(item => String(item.taskId) === taskId)) return;
  sent.outbox.push({
    taskId,
    phone: job.phone,
    memberName: job.memberName || "",
    title: job.title || "",
    description: job.description || "",
    due: job.due || "",
    priority: job.priority || "Orta",
    queuedAt: new Date().toISOString(),
  });
  saveSent(sent);
  console.log(`📥 Kuyruğa alındı: ${job.memberName || ""} / ${job.title}`);
}

function dequeueOutbox(taskId) {
  sent.outbox = (sent.outbox || []).filter(item => String(item.taskId) !== String(taskId));
  saveSent(sent);
}

async function notifyTaskAssigned({ task, profile, phone, memberName }) {
  const taskId = String(task.id);
  const key = `assigned:${taskId}`;
  if (wasAssignedSent(taskId) || sending.has(key)) {
    return { ok: true, alreadySent: true };
  }

  const toPhone = phone || profile?.phone;
  const name = memberName || profile?.full_name || "";
  if (!toPhone) return { ok: false, skipped: true, error: "Üyenin geçerli telefon numarası yok." };

  if (!botReady || !sock) {
    enqueueOutbox({
      taskId,
      phone: toPhone,
      memberName: name,
      title: task.title,
      description: task.description || "",
      due: task.due_date || task.due || "",
      priority: task.priority || "Orta",
    });
    return { ok: true, queued: true };
  }

  sending.add(key);
  sent[key] = "sending";
  saveSent(sent);

  try {
    const message = taskAssignedMessage({
      memberName: name,
      taskTitle: task.title,
      description: task.description,
      due: task.due_date || task.due,
      priority: task.priority,
    });
    const result = await sendWhatsApp(toPhone, message);
    const replyJid = result.result?.key?.remoteJid;
    const replyAlt = result.result?.key?.remoteJidAlt;
    rememberPending(taskId, {
      phone: toPhone,
      jid: result.jid,
      jids: [result.jid, replyJid, replyAlt],
      memberName: name,
      title: task.title,
    });
    sent[key] = new Date().toISOString();
    dequeueOutbox(taskId);
    saveSent(sent);
    console.log(`📨 Onay mesajı gönderildi: ${name} / ${task.title}`);
    return result;
  } catch (err) {
    delete sent[key];
    saveSent(sent);
    enqueueOutbox({
      taskId,
      phone: toPhone,
      memberName: name,
      title: task.title,
      description: task.description || "",
      due: task.due_date || task.due || "",
      priority: task.priority || "Orta",
    });
    console.error(`Gönderilemedi, kuyruğa alındı: ${err.message}`);
    return { ok: true, queued: true, error: err.message };
  } finally {
    sending.delete(key);
  }
}

async function flushOutbox() {
  if (!botReady || !sock || !(sent.outbox || []).length) return;
  const jobs = [...sent.outbox];
  for (const job of jobs) {
    try {
      const result = await notifyTaskAssigned({
        task: {
          id: job.taskId,
          title: job.title,
          description: job.description,
          due_date: job.due,
          priority: job.priority,
        },
        phone: job.phone,
        memberName: job.memberName,
      });
      if (result.ok && !result.queued && !result.skipped) dequeueOutbox(job.taskId);
    } catch (err) {
      console.error(`Kuyruk gönderilemedi (${job.title}):`, err.message);
    }
  }
}

async function sendTaskReminder(task, profile) {
  const key = `reminder:${task.id}:${task.due_date}`;
  if (sent[key]) return false;
  await sendWhatsApp(profile.phone, taskReminderMessage(profile.full_name, task));
  sent[key] = new Date().toISOString();
  saveSent(sent);
  console.log(`⏰ Hatırlatma gönderildi: ${profile.full_name} / ${task.title}`);
  return true;
}

function istanbulDate(offsetDays = 0) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  const base = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00+03:00`);
  base.setDate(base.getDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

async function checkTomorrowReminders() {
  if (reminderRunning || !supabase || !botReady) return;
  reminderRunning = true;
  try {
    const tomorrow = istanbulDate(1);
    const { data: tasks, error: taskError } = await supabase
      .from("tasks")
      .select("id,title,description,due_date,priority,status,assigned_id")
      .eq("due_date", tomorrow)
      .neq("status", "Tamamlandı");

    if (taskError) throw taskError;
    if (!tasks?.length) return;

    const ids = tasks.map(t => t.assigned_id).filter(Boolean);
    if (!ids.length) return;

    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id,full_name,phone,active")
      .in("id", ids);

    if (profileError) throw profileError;
    const profileMap = new Map((profiles || []).map(p => [String(p.id), p]));

    for (const task of tasks) {
      const profile = profileMap.get(String(task.assigned_id));
      if (!profile?.active || !profile.phone) continue;
      try { await sendTaskReminder(task, profile); }
      catch (err) { console.error(`Hatırlatma gönderilemedi (${profile.full_name}):`, err.message); }
    }
  } catch (err) {
    console.error("Hatırlatıcı kontrolü başarısız:", err.message || err);
  } finally {
    reminderRunning = false;
  }
}

async function watchNewTasks() {
  if (watcherRunning || !supabase || !botReady) return;
  watcherRunning = true;
  try {
    const { data: tasks, error: taskError } = await supabase
      .from("tasks")
      .select("id,title,description,due_date,priority,status,assigned_id,created_at")
      .neq("status", "Tamamlandı");
    if (taskError) {
      if (/created_at/i.test(taskError.message || "")) return;
      throw taskError;
    }
    if (!tasks?.length) return;

    const cutoff = Date.now() - 3 * 60 * 1000;
    const pending = tasks.filter(task => {
      if (wasAssignedSent(task.id) || !task.assigned_id || !task.created_at) return false;
      const created = new Date(task.created_at).getTime();
      return Number.isFinite(created) && created >= cutoff;
    });
    if (!pending.length) return;

    const ids = [...new Set(pending.map(t => t.assigned_id).filter(Boolean))];
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id,full_name,phone,active")
      .in("id", ids);
    if (profileError) throw profileError;
    const profileMap = new Map((profiles || []).map(p => [String(p.id), p]));

    for (const task of pending) {
      const profile = profileMap.get(String(task.assigned_id));
      if (!profile?.active || !profile.phone) continue;
      try { await notifyTaskAssigned({ task, profile }); }
      catch (err) { console.error(`Onay mesajı gönderilemedi (${profile.full_name}):`, err.message); }
    }
  } catch (err) {
    console.error("Yeni görev kontrolü başarısız:", err.message || err);
  } finally {
    watcherRunning = false;
  }
}

function foldTr(text) {
  return String(text || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/i̇/g, "i")
    .replace(/[^a-z0-9çgöşü\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDecision(text) {
  const t = foldTr(text);
  if (!t) return null;
  const accept = new Set(["kabul", "kabul et", "kabul ederim", "evet", "tamam", "ok", "olur", "onay", "onayla"]);
  const reject = new Set(["reddet", "red", "hayir", "yok", "olmaz"]);
  if (accept.has(t)) return "accept";
  if (reject.has(t)) return "reject";
  return null;
}

function getMessageText(msg) {
  if (!msg?.message) return "";
  const wrapped =
    msg.message.ephemeralMessage?.message ||
    msg.message.viewOnceMessage?.message ||
    msg.message.viewOnceMessageV2?.message ||
    msg.message.viewOnceMessageV2Extension?.message;
  if (wrapped) return getMessageText({ message: wrapped });

  const content = extractMessageContent(msg.message) || msg.message;
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ""
  ).trim();
}

function messageLookupKeys(msg) {
  const jids = [
    msg.key?.remoteJid,
    msg.key?.remoteJidAlt,
    msg.key?.participant,
    msg.key?.participantAlt,
  ].filter(Boolean);

  const keys = new Set();
  for (const jid of jids) {
    keys.add(jid);
    try { keys.add(jidNormalizedUser(jid)); } catch { /* ignore */ }
    const phone = phoneFromJid(jid);
    if (phone) keys.add(phone);
  }
  return [...keys];
}

function findPendingForMessage(msg) {
  const keys = messageLookupKeys(msg);
  const pending = Object.values(sent.pendingApprovals || {}).filter(p => p.waiting);
  const matches = pending.filter(p => {
    const hay = [p.phone, p.jid, ...(p.jids || [])].filter(Boolean);
    return keys.some(key => hay.includes(key));
  });
  matches.sort((a, b) => String(b.sentAt || "").localeCompare(String(a.sentAt || "")));
  return matches[0] || null;
}

async function findProfileByPhone(phone) {
  if (!supabase || !phone) return null;
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id,full_name,phone,active");
  if (error) throw error;
  const want = normalizePhone(phone);
  return (profiles || []).find(p => p.active !== false && normalizePhone(p.phone) === want) || null;
}

async function latestOpenTaskFor(assignedId) {
  if (!supabase || !assignedId) return null;
  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id,title,description,due_date,priority,status,assigned_id")
    .eq("assigned_id", assignedId)
    .neq("status", "Tamamlandı");
  if (error) throw error;
  const list = tasks || [];
  return list.find(t => t.status === "Bekliyor") || list[0] || null;
}

async function getTask(taskId) {
  if (!supabase || taskId == null) return null;
  const { data, error } = await supabase
    .from("tasks")
    .select("id,title,description,due_date,priority,status,assigned_id")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function applyDecision(task, decision) {
  const status = decision === "accept" ? "Devam Ediyor" : "Bekliyor";
  if (supabase) {
    const { error } = await supabase.from("tasks").update({ status }).eq("id", task.id);
    if (error) console.error("Görev durumu güncellenemedi:", error.message);
  }
  sent.decisions[String(task.id)] = {
    taskId: String(task.id),
    status,
    decision,
    at: new Date().toISOString(),
    acked: false,
  };
  if (sent.pendingApprovals[String(task.id)]) {
    sent.pendingApprovals[String(task.id)].waiting = false;
  }
  saveSent(sent);
  return status;
}

async function handleIncomingMessage(msg) {
  if (!msg?.key || msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) return;
  if (String(remoteJid).endsWith("@broadcast") || String(remoteJid).endsWith("@newsletter")) return;

  const id = msg.key.id || `${remoteJid}:${msg.messageTimestamp}`;
  if (handledMessages.has(id)) return;
  handledMessages.add(id);
  if (handledMessages.size > 2000) {
    const first = handledMessages.values().next().value;
    handledMessages.delete(first);
  }

  const text = getMessageText(msg);
  const decision = parseDecision(text);
  if (!decision) {
    const pending = findPendingForMessage(msg);
    if (pending && text) {
      await sock.sendMessage(remoteJid, {
        text: "Bu görevi onaylamak için *KABUL*, reddetmek için *REDDET* yaz.",
      });
    }
    return;
  }

  let pending = findPendingForMessage(msg);
  let task = pending ? await getTask(pending.taskId) : null;
  let profileName = pending?.memberName || "";

  if (!task && pending) {
    task = {
      id: pending.taskId,
      title: pending.title || "Görev",
      status: "Bekliyor",
    };
  }

  if (!task) {
    const phone = messageLookupKeys(msg).map(normalizePhone).find(Boolean) || pending?.phone;
    const profile = await findProfileByPhone(phone);
    if (profile) {
      task = await latestOpenTaskFor(profile.id);
      profileName = profile.full_name || profileName;
    }
  }

  if (!task) {
    await sock.sendMessage(remoteJid, { text: "Bekleyen görev onayın yok." });
    return;
  }

  const status = await applyDecision(task, decision);
  if (decision === "accept") {
    await sock.sendMessage(remoteJid, {
      text: `✅ Görev kabul edildi: *${task.title}*\nDurum: ${status}`,
    });
  } else {
    await sock.sendMessage(remoteJid, {
      text: `❌ Görev reddedildi: *${task.title}*\nDurum: ${status}`,
    });
  }
  console.log(`📬 ${profileName || "Üye"} görevi ${decision === "accept" ? "kabul etti" : "reddetti"}: ${task.title}`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Geçersiz JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function startApi() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});

    const url = (req.url || "").split("?")[0];

    if (req.method === "GET" && url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        whatsappConnected: botReady,
        queued: (sent.outbox || []).length,
      });
    }

    if (req.method === "GET" && url === "/approvals") {
      const decisions = Object.values(sent.decisions || {}).filter(d => d && !d.acked);
      return sendJson(res, 200, { ok: true, decisions });
    }

    if (req.method === "POST" && url === "/approvals/ack") {
      try {
        const body = await readJson(req);
        const ids = (body.taskIds || []).map(String);
        for (const id of ids) {
          if (sent.decisions[id]) sent.decisions[id].acked = true;
        }
        saveSent(sent);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message || "Ack alınamadı" });
      }
    }

    if (req.method === "POST" && url === "/task-assigned") {
      try {
        const body = await readJson(req);
        console.log("📥 /task-assigned", {
          taskId: body.taskId || null,
          title: body.taskTitle || body.title || null,
          name: body.memberName || null,
          phone: body.phone ? "var" : "yok",
          connected: botReady,
        });
        let task = null;
        let profile = null;

        if (body.taskId && supabase) {
          task = await getTask(body.taskId);
          if (task?.assigned_id) {
            const { data, error } = await supabase
              .from("profiles")
              .select("id,full_name,phone,active")
              .eq("id", task.assigned_id)
              .maybeSingle();
            if (error) throw error;
            profile = data;
          }
        }

        const phone = body.phone || profile?.phone;
        const memberName = body.memberName || profile?.full_name || "";
        task = task || {
          id: body.taskId,
          title: body.taskTitle || body.title,
          description: body.description || "",
          due_date: body.due || body.due_date,
          priority: body.priority,
        };

        if (!task.id || !task.title) throw new Error("taskId ve görev başlığı gerekli.");
        if (!phone) return sendJson(res, 200, { ok: false, skipped: true, error: "Üyenin geçerli telefon numarası yok." });

        const result = await notifyTaskAssigned({ task, profile, phone, memberName });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message || "Mesaj gönderilemedi" });
      }
    }

    if (req.method === "POST" && url === "/send") {
      try {
        const body = await readJson(req);
        const result = await sendWhatsApp(body.phone, body.message || "");
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message || "Mesaj gönderilemedi" });
      }
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`🌐 WhatsApp API 127.0.0.1:${PORT} üzerinde çalışıyor`);
  });
  server.on("error", err => {
    console.error("API sunucu hatası:", err.message);
  });
}

async function startBot() {
  if (botStarting || botReady) return;
  botStarting = true;
  const generation = ++botGeneration;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try { sock.end(undefined); } catch { /* ignore */ }
    sock = null;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const currentSock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Chrome"),
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    });
    sock = currentSock;

    currentSock.ev.on("creds.update", saveCreds);
    currentSock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (generation !== botGeneration) return;
      if (type !== "notify") return;
      for (const msg of messages || []) {
        try { await handleIncomingMessage(msg); }
        catch (err) { console.error("Gelen mesaj işlenemedi:", err.message || err); }
      }
    });
    currentSock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (generation !== botGeneration) return;
      if (qr) {
        console.log("\n📱 QR KODU — WhatsApp'tan okut:\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        botReady = true;
        botStarting = false;
        console.log("\n================================");
        console.log("✅ WHATSAPP BAĞLANDI");
        console.log("🤖 İstanbulls 6064 Bot hazır");
        console.log("================================\n");
        flushOutbox().catch(err => console.error("Kuyruk boşaltılamadı:", err.message));
        checkTomorrowReminders();
        watchNewTasks();
        findAnnouncementGroup();
        watchNewAnnouncements();
      }
      if (connection === "close") {
        botReady = false;
        botStarting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log("❌ Bağlantı kapandı. Kod:", statusCode);
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("⚠️ WhatsApp oturumu kapatılmış. QR için botu yeniden başlat.");
          return;
        }
        if (reconnectTimer) {
          console.log("Yeniden bağlanma zaten planlı.");
          return;
        }
        const delay = statusCode === DisconnectReason.connectionReplaced ? 30000 : 8000;
        console.log(`🔄 ${delay / 1000}s sonra yeniden bağlanılacak...`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (generation !== botGeneration) return;
          if (botReady || botStarting) return;
          startBot().catch(console.error);
        }, delay);
      }
    });
  } catch (err) {
    botStarting = false;
    throw err;
  }
}

startApi();
startBot().catch(err => console.error("BOT HATASI:", err));
setInterval(checkTomorrowReminders, 5 * 60 * 1000);
setInterval(watchNewTasks, 15 * 1000);
setInterval(watchNewAnnouncements, 15 * 1000);
setInterval(() => { flushOutbox().catch(() => {}); }, 10 * 1000);
